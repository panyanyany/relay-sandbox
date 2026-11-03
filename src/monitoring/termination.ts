import { join } from "node:path";
import { writeJson } from "../storage/files.js";
import { taskPath } from "../tasks/store.js";
import { formatError } from "../audit/redaction.js";
import type { Task } from "../tasks/types.js";

export const stopSources = [
  "cancel",
  "timeout",
  "supervisor",
  "collection",
  "delivery",
  "cleanup",
  "resume",
  "failure",
  "resource_stop",
] as const;
export type StopSource = (typeof stopSources)[number];
export interface StopRecord {
  source: StopSource;
  round: number;
  requestedAt: string;
  finishedAt?: string;
  status: "requested" | "completed" | "failed";
  error?: string;
  diagnosticError?: string;
}
// 每类停止只保留最近一次；日志写入失败也必须执行停止，不能让磁盘故障破坏隔离收尾。
export async function recordStop<T>(
  home: string,
  task: Task,
  source: StopSource,
  operation: () => Promise<T>,
) {
  const path = join(
    taskPath(home, task.id),
    "telemetry",
    `stop-${source}.json`,
  );
  const base = {
    taskId: task.id,
    containerId: task.containerId,
    round: task.round,
    source,
    requestedAt: new Date().toISOString(),
  };
  const errors: unknown[] = [];
  try {
    await writeJson(path, { ...base, status: "requested" });
  } catch (error) {
    errors.push(error);
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
    errors.push(error);
  }
  try {
    await writeJson(path, {
      ...base,
      status: failure ? "failed" : "completed",
      finishedAt: new Date().toISOString(),
      ...(failure ? { error: formatError(failure) } : {}),
      ...(errors.length && !failure
        ? { diagnosticError: formatError(errors[0]) }
        : {}),
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "停止或诊断保存失败", {
      cause: errors[0],
    });
  return result as T;
}
