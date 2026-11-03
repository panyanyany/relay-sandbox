import { collectTask } from "./run.js";
import { getTask, saveTask } from "./store.js";
import { withTaskLock } from "./lock.js";
import { requireEnvironmentReady, canRecollect } from "./readiness.js";
import { formatError } from "../audit/redaction.js";

// 重试只读取原工作区，不启动Agent、不增加轮次；持久环境归属由collectTask再次检查。
export async function recollectTask(home: string, id: string) {
  return withTaskLock(home, id, async () => {
    const task = await getTask(home, id);
    requireEnvironmentReady(task);
    if (
      !canRecollect(task) &&
      !(task.state === "collecting" && task.failureStage === "collection")
    )
      throw new Error("仅产物收集失败的任务可重试收集，请先检查任务失败阶段");
    try {
      return await collectTask(home, task);
    } catch (error) {
      if (
        ["stopped", "interrupted", "cleaned"].includes(
          (await getTask(home, id)).state,
        )
      )
        throw error;
      task.state = "failed";
      task.error = formatError(error);
      await saveTask(home, task);
      throw error;
    }
  });
}
