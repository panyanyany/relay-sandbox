import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask, saveTask, taskPath } from "./store.js";
import { withTaskLock } from "./lock.js";
import { formatError } from "../audit/redaction.js";
export type BackgroundOperation = "run" | "prepare" | "check-candidate";
// 派发前置为 queued，防止后台进程尚未启动时旧制品被并发应用。
export async function dispatchOperation(
  home: string,
  id: string,
  operation: BackgroundOperation,
  prompt?: string,
) {
  const task = await withTaskLock(home, id, async () => {
    const task = await getTask(home, id);
    if (
      [
        "stopped",
        "interrupted",
        "queued",
        "running",
        "applying",
        "completed",
        "cleaned",
      ].includes(task.state)
    )
      throw new Error("任务状态不允许派发");
    task.state = "queued";
    task.deliveryPrepared = false;
    delete task.review;
    task.checks = [];
    await saveTask(home, task);
    return task;
  });
  const source = import.meta.url.endsWith(".ts"),
    entry = fileURLToPath(
      new URL(source ? "../cli/main.ts" : "../cli/main.js", import.meta.url),
    );
  const log = await open(join(taskPath(home, id), "worker.log"), "a", 0o600);
  try {
    const args =
      operation === "run" && prompt ? ["rework", id, prompt] : [operation, id];
    const child = spawn(
      process.execPath,
      [...(source ? ["--import", "tsx"] : []), entry, "--home", home, ...args],
      { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return { taskId: id, workerPid: child.pid, status: "dispatched" };
  } catch (error) {
    task.state = "failed";
    task.error = formatError(error);
    await saveTask(home, task);
    throw error;
  } finally {
    await log.close();
  }
}
// CLI 启动和 MCP 开发入口共用后台派发，长调用通过 wait_task 等待或 get_task 查询。
export async function dispatchTask(home: string, id: string, prompt?: string) {
  return dispatchOperation(home, id, "run", prompt);
}
