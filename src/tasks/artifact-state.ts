import { rm } from "node:fs/promises";
import { join } from "node:path";
import { taskPath, saveTask } from "./store.js";
import type { Task } from "./types.js";

// 候选失效不等于收集快照失效；直接挂载恢复仍须核对原收集清单。
export function invalidateCandidate(task: Task) {
  task.deliveryPrepared = false;
  delete task.candidateGeneration;
  delete task.review;
  task.checks = [];
}
// 新开发或重收集一旦开始，旧结果就不再是可交付事实。
export function invalidateResult(task: Task) {
  invalidateCandidate(task);
  delete task.artifactDigest;
  delete task.resultGeneration;
}

// 错误示范：只清审核摘要仍会留下可被重新确认的旧候选和旧计划。
export async function discardCandidate(home: string, task: Task) {
  invalidateCandidate(task);
  await saveTask(home, task);
  for (const name of ["candidate", "current", "apply-plan.json"])
    await rm(join(taskPath(home, task.id), name), {
      recursive: true,
      force: true,
    });
}

// 人工解决冲突可以修改候选，但必须来自当前收集代次的准备流程。
export function requireCurrentCandidate(task: Task) {
  if (
    !task.resultGeneration ||
    task.candidateGeneration !== task.resultGeneration
  )
    throw new Error("候选不属于当前收集结果，请先重新准备交付");
}
