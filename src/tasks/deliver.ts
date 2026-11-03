import { withTaskLock } from "./lock.js";
import { join } from "node:path";
import { getTask, saveTask, taskPath } from "./store.js";
import { isReady } from "../delivery/policy.js";
import { applyChanges, readPlan, withProjectLock } from "../delivery/apply.js";
import { manifestDigest, scan } from "../workspace/manifest.js";
import { reviewSchema } from "../agents/host/review-schema.js";
import { taskProjectMode } from "../workspace/access.js";
import { confirmDirectProject } from "./direct-project.js";
// 只接受宿主入口提交的摘要绑定结论，内层无法接触宿主 MCP。
async function reviewTaskLocked(home: string, id: string, input: unknown) {
  const decision = reviewSchema.parse(input);
  const task = await getTask(home, id);
  if (!task.deliveryPrepared)
    throw new Error("尚未准备最终候选，请先 prepare_delivery");
  if (!["checking", "ready", "blocked"].includes(task.state))
    throw new Error("当前状态不能提交审查结论");
  if (
    decision.taskId !== id ||
    decision.artifactDigest !== task.artifactDigest ||
    decision.configDigest !== task.configDigest
  )
    throw new Error("审查结论已过期或不属于此任务");
  task.review = decision;
  task.state = isReady(task) ? "ready" : "blocked";
  await saveTask(home, task);
  return task;
}
async function applyTaskLocked(home: string, id: string) {
  const task = await getTask(home, id);
  if (task.state !== "ready" || !isReady(task))
    throw new Error("未满足交付条件，请先准备最终候选并完成配置的检查");
  const root = taskPath(home, id),
    plan = await readPlan(join(root, "apply-plan.json"));
  if (
    plan.taskId !== id ||
    plan.artifactDigest !== task.artifactDigest ||
    plan.configDigest !== task.configDigest ||
    manifestDigest(await scan(join(root, "candidate"))) !== task.artifactDigest
  )
    throw new Error("最终候选或检查策略发生变化");
  task.state = "applying";
  task.applicationStatus = "in_progress";
  await saveTask(home, task);
  try {
    if ((await taskProjectMode(home, task)) === "direct") {
      await confirmDirectProject(home, task);
    } else
      await withProjectLock(task.projectRoot, () =>
        applyChanges(
          task.projectRoot,
          join(root, "candidate"),
          join(root, "backup"),
          plan,
        ),
      );
    task.state = "completed";
    task.applicationStatus = "applied";
    if (!task.config.delivery.aiReview && !task.config.delivery.checks.length)
      task.warnings.push("未执行交付检查");
    await saveTask(home, task);
    return task;
  } catch (error) {
    task.state = "failed";
    task.applicationStatus = "failed";
    task.error = error instanceof Error ? error.message : String(error);
    await saveTask(home, task);
    throw error;
  }
}

// 宿主并发入口共享任务互斥边界。
export async function applyTask(home: string, id: string) {
  return withTaskLock(home, id, () => applyTaskLocked(home, id));
}

// 宿主并发入口共享任务互斥边界。
export async function reviewTask(home: string, id: string, input: unknown) {
  return withTaskLock(home, id, () => reviewTaskLocked(home, id, input));
}
