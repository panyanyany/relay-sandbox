import { randomUUID } from "node:crypto";
import { discardCandidate } from "./artifact-state.js";
import { requireRuntimeOwner } from "../environments/ownership.js";
import { formatError } from "../audit/redaction.js";
import { withTaskLock } from "./lock.js";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { snapshot } from "../workspace/snapshot.js";
import { verifyCandidate } from "./candidate.js";
import { mergeCandidate } from "../delivery/merge.js";
import { getTask, saveTask, taskPath } from "./store.js";
import { taskProjectMode } from "../workspace/access.js";
import { prepareDirectProject } from "./direct-project.js";
// 合并、检查、应用由任务层顺序编排，不让三个模块彼此递归调用。
async function prepareDeliveryLocked(home: string, id: string) {
  const task = await getTask(home, id);
  await requireRuntimeOwner(home, task);
  if (!task.artifactDigest || !task.containerId)
    throw new Error("尚未收集开发结果");
  if (["running", "applying", "completed", "cleaned"].includes(task.state))
    throw new Error("当前状态不允许准备交付");
  const root = taskPath(home, id),
    current = join(root, "current"),
    candidate = join(root, "candidate");
  task.resultGeneration ??= randomUUID();
  task.state = "checking";
  await discardCandidate(home, task);
  if ((await taskProjectMode(home, task)) === "direct") {
    // 直接模式先停止开发进程，再构建当前代次的事后检查候选。
    try {
      await prepareDirectProject(home, task);
      task.candidateGeneration = task.resultGeneration;
      await saveTask(home, task);
      return await verifyCandidate(home, task);
    } catch (error) {
      task.state = "failed";
      task.error = formatError(error);
      await saveTask(home, task);
      throw error;
    }
  }
  await snapshot(task.projectRoot, current, task.config.project.exclude);
  await cp(current, candidate, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  const merged = await mergeCandidate(
    join(root, "baseline"),
    join(root, "result"),
    current,
    candidate,
  );
  task.candidateGeneration = task.resultGeneration;
  await saveTask(home, task);
  if (merged.conflicts.length) {
    task.state = "awaiting_user";
    await saveTask(home, task);
    return { task, conflicts: merged.conflicts };
  }
  return verifyCandidate(home, task);
}

// 宿主并发入口共享任务互斥边界。
export async function prepareDelivery(home: string, id: string) {
  return withTaskLock(home, id, () => prepareDeliveryLocked(home, id));
}
