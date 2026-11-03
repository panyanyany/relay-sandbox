import { diagnoseEnvironment } from "../tasks/environment-diagnostics.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDecoyManifest } from "../decoys/manifest.js";
import type { FrozenPolicy } from "../permissions/types.js";
import { writeJson, readJson } from "../storage/files.js";
import {
  loadMainEnvironment,
  saveEnvironmentState,
  environmentSummarySchema,
} from "../tasks/environment-state.js";
import { taskPath } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { environmentPath } from "./store.js";

// 环境持续保存诱饵身份；新任务只重建代理和证书，不能换值后漏掉旧诱饵外发。
async function prepareAudit(home: string, task: Task, policy: FrozenPolicy) {
  if (!policy.decoys.enabled) return;
  const root = environmentPath(home, task.projectId);
  const manifest = await ensureDecoyManifest(
    join(root, "decoys.json"),
    task.environmentId!,
    policy.decoys,
  );
  await mkdir(join(taskPath(home, task.id), "decoys"), {
    recursive: true,
    mode: 0o700,
  });
  await writeJson(join(taskPath(home, task.id), "decoys/manifest.json"), {
    ...manifest,
    taskId: task.id,
  });
  try {
    const previous = environmentSummarySchema.parse(
      await readJson(join(root, "audit-summary.json")),
    );
    await saveEnvironmentState(home, task.id, {
      summary: {
        ...previous,
        runtimeId: task.environmentId!,
        traffic: "stopped",
      },
    });
    task.warnings.push(
      "复用历史环境：既有软件、用户配置和敏感修改可能保留，历史诱饵位置未重新确认；可显式重置环境",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
// 可选审计准备失败只降级观察；覆盖缺口写盘失败仍应向上抛出。
export async function preparePersistentAudit(
  home: string,
  task: Task,
  policy: FrozenPolicy,
): Promise<boolean> {
  try {
    await prepareAudit(home, task, policy);
    return true;
  } catch (error) {
    const gap = "persistent-audit-unavailable";
    await diagnoseEnvironment(home, task.id, task.id, gap, error);
    await saveEnvironmentState(
      home,
      task.id,
      {
        summary: {
          schemaVersion: 1,
          runtimeId: task.id,
          containerId: task.containerId!,
          role: "main",
          enabled: true,
          traffic: "unavailable",
          placements: [],
          gaps: [gap],
        },
      },
      true,
    );
    task.warnings.push(
      "持久审计初始化失败，历史诱饵匹配不可用；详见审计覆盖缺口及脱敏诊断",
    );
    // 错误示范：失败后继续安装会重新生成清单，错误宣称覆盖历史诱饵。
    return false;
  }
}
// 仅保存最小安装位置，历史事件仍留在原任务，不混入新任务计数。
export async function rememberPersistentAudit(home: string, task: Task) {
  const current = await loadMainEnvironment(home, task.id);
  if (!current?.summary.enabled) return;
  const root = environmentPath(home, task.projectId);
  let previous;
  try {
    previous = environmentSummarySchema.parse(
      await readJson(join(root, "audit-summary.json")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const placements = new Map(
    current.summary.placements.map((item) => [item.id, item]),
  );
  for (const item of previous?.placements ?? [])
    if (item.status === "installed") placements.set(item.id, item);
  await writeJson(join(root, "audit-summary.json"), {
    ...current.summary,
    runtimeId: task.environmentId,
    placements: [...placements.values()],
    traffic: "stopped",
    helperRoot: undefined,
  });
}
