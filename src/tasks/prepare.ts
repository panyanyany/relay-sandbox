import { withTaskLock } from "./lock.js";
import { join } from "node:path";
import { rm, cp } from "node:fs/promises";
import { snapshot } from "../workspace/snapshot.js";
import { verifyCandidate } from "./candidate.js";
import { mergeCandidate } from "../delivery/merge.js";
import { getTask, saveTask, taskPath } from "./store.js";
// 合并、检查、应用由任务层顺序编排，不让三个模块彼此递归调用。
async function prepareDeliveryLocked(home: string, id: string) {
  const task = await getTask(home, id);
  if (!task.artifactDigest || !task.containerId)
    throw new Error("尚未收集开发结果");
  if (["running", "applying", "completed", "cleaned"].includes(task.state))
    throw new Error("当前状态不允许准备交付");
  const root = taskPath(home, id),
    current = join(root, "current"),
    candidate = join(root, "candidate");
  await rm(current, { recursive: true, force: true });
  await rm(candidate, { recursive: true, force: true });
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
