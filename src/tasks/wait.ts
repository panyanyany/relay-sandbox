import { readPressure } from "../monitoring/pressure.js";
import { preparationCancelled } from "./preparation-control.js";
import { environmentReady, preparationHandoffPending } from "./readiness.js";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { taskNextAction } from "./guidance.js";
import { getTask } from "./store.js";

// 内容摘要可识别同一状态内的修改，避免只比较时间戳或状态漏掉更新。
export async function taskSnapshot(home: string, id: string) {
  const stored = await getTask(home, id);
  const ready =
    environmentReady(stored) &&
    !(await preparationHandoffPending(home, stored));
  const task = {
    ...stored,
    environmentReady: ready,
    cancellationRequested: await preparationCancelled(home, id),
    resourceWarnings: await readPressure(home, id),
  };
  const revision = createHash("sha256")
    .update(JSON.stringify(task))
    .digest("hex");
  return {
    task,
    revision,
    environmentReady: environmentReady(task),
    nextAction: taskNextAction(task),
  };
}

// 等待不持有任务锁；跨进程更新通过宿主文件轮询发现，取消不停止后台任务。
export async function waitTask(
  home: string,
  id: string,
  afterRevision: string,
  timeoutSeconds = 25,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{64}$/.test(afterRevision))
    throw new Error("任务版本游标非法");
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 55
  )
    throw new Error("等待时间须为 1–55 秒");
  const deadline = performance.now() + timeoutSeconds * 1000;
  for (;;) {
    signal?.throwIfAborted();
    const snapshot = await taskSnapshot(home, id);
    if (snapshot.revision !== afterRevision)
      return { ...snapshot, reason: "changed" as const };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...snapshot, reason: "timeout" as const };
    await setTimeout(Math.min(250, remaining), undefined, { signal });
  }
}
