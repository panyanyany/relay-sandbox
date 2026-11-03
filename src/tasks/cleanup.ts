import { recordStop, type StopSource } from "../monitoring/termination.js";
import { requestPreparationCancellation } from "./preparation-control.js";
import { withTaskLock } from "./lock.js";
import { ownsRuntime, releaseEnvironment } from "../environments/ownership.js";
import { rememberPersistentAudit } from "../environments/audit.js";
import { stopMonitor } from "../monitoring/monitor.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getTask, saveTask, taskPath } from "./store.js";
import { dockerClient } from "../docker/client.js";
import { stopRuntime } from "../docker/runtime.js";
import { formatError } from "../audit/redaction.js";
import {
  stopEnvironments,
  purgeEnvironmentSecrets,
} from "./environment-lifecycle.js";
import type { Task } from "./types.js";

// 各资源独立尝试；404是已删除，其余失败汇总给调用方，不能假报全部停止。
async function taskContainers(
  task: Task,
  errors: unknown[],
  includeMain = true,
): Promise<string[]> {
  const ids = new Set<string>(
    includeMain && task.containerId ? [task.containerId] : [],
  );
  try {
    for (const item of await dockerClient().listContainers({
      all: true,
      filters: { label: [`relay-sandbox.task=${task.id}`] },
    }))
      ids.add(item.Id);
  } catch (error) {
    errors.push(error);
  }
  return [...ids].sort(
    (a, b) => Number(a === task.containerId) - Number(b === task.containerId),
  );
}
async function attempt(operation: () => Promise<unknown>, errors: unknown[]) {
  try {
    await operation();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404)
      errors.push(error);
  }
}
async function recordFailure(
  home: string,
  task: Task,
  error: unknown,
  warning: string,
): Promise<never> {
  task.error = formatError(error);
  if (!task.warnings.includes(warning)) task.warnings.push(warning);
  try {
    await saveTask(home, task);
  } catch (persist) {
    throw new AggregateError([error, persist], "资源操作与错误记录均失败", {
      cause: error,
    });
  }
  throw error;
}
// 监督和恢复也使用同一真实停止入口，但自行决定成功后的业务状态。
export async function stopTaskResources(
  home: string,
  task: Task,
  source: StopSource = "resource_stop",
): Promise<void> {
  return recordStop(home, task, source, async () => {
    const errors: unknown[] = [];
    await attempt(
      () => stopEnvironments(dockerClient(), home, task.id),
      errors,
    );
    for (const id of await taskContainers(
      task,
      errors,
      await ownsRuntime(home, task),
    ))
      await attempt(() => stopRuntime(dockerClient(), id), errors);
    if (errors.length)
      throw new AggregateError(errors, "任务部分运行资源未确认停止");
  });
}
// 准备阶段共享租约；不能一边清理目录，一边继续创建或借用项目环境。
async function withPreparationLock<T>(
  home: string,
  id: string,
  operation: () => Promise<T>,
  cancel = false,
) {
  const task = await getTask(home, id);
  if (task.state !== "preparing" || task.environmentReady !== false)
    return operation();
  if (cancel) await requestPreparationCancellation(home, id);
  try {
    return await withTaskLock(home, id, operation);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      (error as NodeJS.ErrnoException).path ===
        join(taskPath(home, id), "operation.lock")
    ) {
      if (cancel) {
        const latest = await getTask(home, id);
        // 准备已发布完成时只剩锁收尾，走正常停止，避免迟到取消永久悬挂。
        if (latest.state !== "preparing") return operation();
        return { ...latest, cancellationRequested: true };
      }
      throw new Error(
        "环境正在准备，暂不能并发停止或清理；请等待准备结束后重试",
        { cause: error },
      );
    }
    throw error;
  }
}
export async function stopTask(home: string, id: string) {
  return withPreparationLock(home, id, () => stopTaskUnlocked(home, id), true);
}
async function stopTaskUnlocked(home: string, id: string) {
  const task = await getTask(home, id);
  if (task.state === "applying")
    throw new Error("应用正在进行，不能中途清理；请等待结果并检查应用日志");
  if (task.state === "cleaned") return task;
  try {
    await stopTaskResources(home, task, "cancel");
  } catch (error) {
    return recordFailure(
      home,
      task,
      error,
      "停止未完全成功，不能确认整个任务已停止",
    );
  }
  if (task.environmentId && (await ownsRuntime(home, task))) {
    await rememberPersistentAudit(home, task);
    await releaseEnvironment(home, task);
  }
  if (task.state !== "completed") task.state = "stopped";
  await saveTask(home, task);
  return task;
}
// 只有全部运行资源和网络回收成功后才删除副本；授权源从不在删除清单中。
export async function cleanupTask(home: string, id: string) {
  return withPreparationLock(home, id, () => cleanupTaskUnlocked(home, id));
}
async function cleanupTaskUnlocked(home: string, id: string) {
  const task = await getTask(home, id);
  if (task.state === "applying") throw new Error("应用过程中不能清理");
  if (task.state === "cleaned") return task;
  const docker = dockerClient(),
    errors: unknown[] = [];
  await attempt(() => stopMonitor(home, id), errors);
  if (task.environmentId && (await ownsRuntime(home, task))) {
    await attempt(() => stopTaskResources(home, task, "cleanup"), errors);
    await attempt(() => rememberPersistentAudit(home, task), errors);
  }
  await attempt(() => stopEnvironments(docker, home, id), errors);
  for (const containerId of await taskContainers(
    task,
    errors,
    !task.environmentId,
  ))
    await attempt(
      () => docker.getContainer(containerId).remove({ force: true, v: true }),
      errors,
    );
  const networks = new Set<string>(
    !task.environmentId && task.networkId ? [task.networkId] : [],
  );
  try {
    for (const network of await docker.listNetworks({
      filters: { label: [`relay-sandbox.task=${id}`] },
    }))
      networks.add(network.Id);
  } catch (error) {
    errors.push(error);
  }
  for (const networkId of networks)
    await attempt(() => docker.getNetwork(networkId).remove(), errors);
  if (errors.length)
    return recordFailure(
      home,
      task,
      new AggregateError(errors, "任务资源清理不完整，可修复后重试"),
      "资源清理未完全成功，任务尚未清理完毕",
    );
  await attempt(() => purgeEnvironmentSecrets(home, id), errors);
  if (!errors.length)
    for (const name of [
      "baseline",
      "result",
      "current",
      "candidate",
      "resources",
      "check-resources",
      "decoys",
      "host-baseline",
      "environment-current",
      "delivery-sync",
    ])
      await attempt(
        () =>
          rm(join(taskPath(home, id), name), { recursive: true, force: true }),
        errors,
      );
  if (errors.length)
    return recordFailure(
      home,
      task,
      new AggregateError(errors, "任务副本或私密材料清理不完整"),
      "文件清理未完全成功，可重试",
    );
  await releaseEnvironment(home, task);
  task.state = "cleaned";
  task.cleanedAt = new Date().toISOString();
  await saveTask(home, task);
  return task;
}
