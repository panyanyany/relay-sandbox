import { buildPolicySummary } from "../reporting/policy-summary.js";
import type { ApplyPlan } from "../delivery/apply.js";
import { taskNextAction } from "./guidance.js";
import { join } from "node:path";
import { z } from "zod";
import { reviewSchema } from "../agents/host/review-schema.js";
import { getTask, taskPath } from "./store.js";
import { readJson } from "../storage/files.js";
import { changes } from "../workspace/diff.js";
import { readStable, type Manifest } from "../workspace/manifest.js";
import { telemetryStatus } from "../monitoring/status.js";
import { loadAudit, summarizeAudit } from "../audit/load.js";
// 只有尚未生成的证据允许缺省；格式或权限错误必须保留。
async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function taskResult(home: string, id: string) {
  const task = await getTask(home, id),
    root = taskPath(home, id);
  const baseline = await optionalJson<Manifest>(
      join(
        root,
        task.workspaceSync?.deliveryBase
          ? "delivery-baseline.json"
          : "baseline.json",
      ),
    ),
    result = await optionalJson<Manifest>(join(root, "result.json"));
  const plan = await optionalJson<ApplyPlan>(join(root, "apply-plan.json"));
  const policy = await buildPolicySummary(home, id);
  return {
    task,
    nextAction: taskNextAction(task),
    artifactDirectory: root,
    applicationPlan:
      plan &&
      task.deliveryPrepared &&
      plan.artifactDigest === task.artifactDigest &&
      plan.configDigest === task.configDigest
        ? {
            taskId: plan.taskId,
            kind:
              policy.projectMode === "direct"
                ? "post_write_changes"
                : "pending_changes",
            artifactDigest: plan.artifactDigest,
            configDigest: plan.configDigest,
            changeCount: plan.changes.length,
            changes: plan.changes.slice(0, 50),
            truncated: plan.changes.length > 50,
            detailTool: "get_delivery_plan",
          }
        : null,
    changes:
      task.artifactDigest && baseline && result
        ? changes(baseline, result)
        : [],
    audit: summarizeAudit(await loadAudit(home, id)),
    policy,
    monitoring: await telemetryStatus(home, id),
    reviewSchema: z.toJSONSchema(reviewSchema),
    reviewInstructions:
      (taskNextAction(task) === "collect_artifacts"
        ? "产物收集失败：先调用collect_artifacts并等待收集完成，再执行交付检查；重试收集不重跑开发Agent。异常收尾建议适用于放弃重试后。"
        : "") +
      (policy.projectMode === "direct"
        ? "原项目已直接挂载：修改可能已生效。applicationPlan列出相对基线的事后变化；apply_task只确认检查结果，不回写或回滚。拒绝后仍须上报原项目可能已变更。"
        : "") +
      "审查最终 candidate 与 applicationPlan；verdict 评价交付代码，运行期审计单独上报，不因审计事件或部分覆盖而拒绝正确代码；应用计划已在本结果中提供，详情用 get_delivery_plan；read_artifact 只读取项目文件。提交 schemaVersion=1、绑定任务及双摘要的结构化审查（verdict、summary、findings），不确定时使用 needs_attention；完成或异常收尾时调用 cleanup_task，然后调用 report_task，并将返回的 reportId、userMessage 原样作为最终用户回复。",
  };
}
// 有界读取任务内候选/结果；逐层禁止链接解析，不能读取宿主任意文件。
export async function readArtifact(
  home: string,
  id: string,
  kind: "baseline" | "result" | "candidate",
  path: string,
  offset = 0,
) {
  await getTask(home, id);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("制品游标非法");
  const data = await readStable(join(taskPath(home, id), kind), path),
    chunk = data.subarray(offset, offset + 65536);
  return {
    encoding: "base64",
    data: chunk.toString("base64"),
    next: offset + chunk.length,
    total: data.length,
  };
}

// 宿主元数据有独立入口，不把任意宿主路径开放给模型。
export async function deliveryPlanPage(
  home: string,
  id: string,
  offset: number,
  limit: number,
) {
  const task = await getTask(home, id);
  if (!task.deliveryPrepared) throw new Error("最终候选尚未准备");
  const plan = await readJson<ApplyPlan>(
    join(taskPath(home, id), "apply-plan.json"),
  );
  return {
    taskId: id,
    artifactDigest: plan.artifactDigest,
    configDigest: plan.configDigest,
    changes: plan.changes.slice(offset, offset + limit),
    total: plan.changes.length,
    next: Math.min(plan.changes.length, offset + limit),
  };
}
