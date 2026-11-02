import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { z } from "zod";
import {
  frozenPolicySchema as frozenSchema,
  POLICY_MAX_BYTES,
} from "../permissions/contract.js";
import { taskPath } from "../tasks/store.js";
import { environmentSummarySchema } from "../tasks/environment-state.js";
import {
  readTrafficEvidence,
  readBoundedEvidence,
  orderEnvironmentIds,
} from "./traffic-evidence.js";

// 逐层固定目录句柄且拒绝链接，只从任务内固定相对位置读取有界数据。
async function relativeHandle(root: string, path: string, directory = false) {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("invalid-path");
  let handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (let index = 0; index < parts.length; index++) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${parts[index]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (index < parts.length - 1 || directory ? constants.O_DIRECTORY : 0),
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function boundedJson(
  root: string,
  path: string,
  limit = 65536,
): Promise<unknown> {
  return JSON.parse(
    (await readBoundedEvidence(root, path, limit)).toString("utf8"),
  );
}
// 只提取公开状态；私密handle、CA、清单和请求内容不进入报告。
async function environments(root: string, gaps: string[]) {
  let names: string[];
  try {
    const handle = await relativeHandle(root, "traffic", true);
    try {
      names = await readdir(`/proc/self/fd/${handle.fd}`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      gaps.push("environment-records-unavailable");
    return [];
  }
  const result = [];
  const orderedGaps = new Set<string>();
  const ids = await orderEnvironmentIds(
    root,
    names
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))
      .sort(),
    orderedGaps,
  );
  gaps.push(...orderedGaps);
  if (ids.length > 32) gaps.push("environment-records-truncated");
  for (const id of ids.slice(0, 32)) {
    try {
      const summary = environmentSummarySchema.parse(
        await boundedJson(root, `traffic/${id}/summary.json`),
      );
      if (
        summary.runtimeId !== id ||
        (summary.helperRoot !== undefined &&
          summary.helperRoot !== `/opt/relay-sandbox/audit/${id}`)
      )
        throw new Error("invalid-environment");
      result.push({
        runtimeId: id,
        role: summary.role,
        traffic: summary.traffic,
      });
      gaps.push(...summary.gaps);
      if (
        summary.traffic === "unavailable" ||
        summary.traffic === "cleanup_pending"
      )
        gaps.push("traffic-component-unavailable");
    } catch {
      gaps.push("environment-record-invalid");
    }
  }
  return result;
}

// 权限事实与运行证据分离；损坏快照不能被当作legacy或无风险。
export async function buildPolicySummary(home: string, id: string) {
  const root = taskPath(home, id),
    gaps: string[] = [];
  let mode: "frozen" | "legacy" | "unavailable" = "legacy";
  let policy: z.infer<typeof frozenSchema> | undefined;
  try {
    policy = frozenSchema.parse(
      await boundedJson(root, "policy.json", POLICY_MAX_BYTES),
    );
    mode = "frozen";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      mode = "unavailable";
      gaps.push(
        (error as NodeJS.ErrnoException).code === "EFBIG"
          ? "policy-record-oversized"
          : "policy-record-unavailable",
      );
    }
  }
  const states = await environments(root, gaps);
  if (policy?.decoys.enabled && !states.length)
    gaps.push("environment-records-missing");
  const evidence =
    policy?.decoys.enabled === false
      ? {
          events: [],
          eventCount: 0,
          gaps: [],
          truncated: false,
          coverage: "disabled" as const,
        }
      : await readTrafficEvidence(home, id);
  if (mode === "legacy") gaps.push("legacy-policy-no-new-grants");
  if (
    policy &&
    (policy.resources.length > 100 || policy.network.grants.length > 50)
  )
    gaps.push("permission-summary-truncated");
  const combinedGaps = [...new Set([...gaps, ...evidence.gaps])];
  const boundedGaps =
    combinedGaps.length > 64
      ? [...combinedGaps.slice(0, 63), "summary-gaps-truncated"]
      : combinedGaps;
  return {
    mode,
    network: {
      mode: policy ? "default-open" : mode === "legacy" ? "legacy" : "unknown",
      grants: policy?.network.grants.slice(0, 50) ?? [],
    },
    resources:
      policy?.resources.slice(0, 100).map(({ name, target, mode, access }) => ({
        name,
        target,
        mode,
        access,
      })) ?? [],
    directHostWritesPossible: policy
      ? policy.resources.some(
          (resource) =>
            resource.mode === "direct" && resource.access === "read-write",
        )
      : null,
    decoysEnabled: policy?.decoys.enabled ?? null,
    environments: states,
    traffic: { ...evidence, gaps: boundedGaps },
  };
}

// 命中、恶意和远端收到是不同事实；不把未应用项目等同宿主未变化。
export function policySummaryLines(
  summary: Awaited<ReturnType<typeof buildPolicySummary>>,
) {
  return [
    `行为策略：${summary.mode === "frozen" ? "使用冻结宿主授权" : summary.mode === "legacy" ? "旧任务保留原有边界" : "授权记录不可用，影响范围未知"}。`,
    ...(summary.directHostWritesPossible
      ? [
          "宿主资源：存在直接可写授权，运行期间可能已即时修改宿主资源，不经过交付审核；原项目未应用不等于全部宿主资源未改。",
        ]
      : []),
    ...summary.resources
      .filter(
        (resource) =>
          resource.mode === "direct" && resource.access === "read-write",
      )
      .slice(0, 10)
      .map(
        (resource) =>
          `直接可写资源：${resource.name}，沙箱路径 ${resource.target}；宿主源是否变化需单独核查。`,
      ),
    `通信内容审计：${summary.traffic.coverage === "disabled" ? "未启用" : summary.traffic.coverage === "unavailable" ? "不可用" : "部分覆盖"}；已扫描命中 ${summary.traffic.eventCount} 项。`,
    ...summary.traffic.events
      .slice(0, 10)
      .map(
        (event) =>
          `通信记录：${event.decoyId}，${event.host}:${event.port}，${event.location}，${event.encoding}。`,
      ),
    "通信命中不等同恶意，也不能证明远端已接收；未命中不代表没有外传。运行风险只提醒，交付代码独立审核。",
    ...(summary.traffic.eventCount > 10
      ? ["用户消息仅展示前10项通信命中，结构化报告提供有界记录。"]
      : []),
    ...(summary.traffic.truncated
      ? ["通信记录已截断，仅展示有界保留证据；已扫描命中数不是全部历史总数。"]
      : []),
    ...summary.traffic.gaps.map((gap) => `通信或授权缺口：${gap}`),
  ];
}
