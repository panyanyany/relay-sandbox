import { claimEnvironment, ownsRuntime } from "../environments/ownership.js";
import { readFrozenPolicy } from "../permissions/freeze.js";
import { formatError } from "../audit/redaction.js";
import { stopTaskResources } from "./cleanup.js";
import { refreshEnvironments } from "./environment-lifecycle.js";
import { restartTaskRuntime } from "./restart.js";
import { startMonitor } from "../monitoring/monitor.js";
import { collectGarbage } from "./garbage-collection.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { listTasks, getTask, saveTask, taskPath } from "./store.js";
import { processIdentity, type OperationLease, withTaskLock } from "./lock.js";
import { dockerClient } from "../docker/client.js";
import { installPolicy } from "../network/policy.js";
import { profileSchema } from "../config/schema.js";
import { readJson } from "../storage/files.js";
import type { Task } from "./types.js";
import { taskProjectMode, validateDirectRuntime } from "../workspace/access.js";
// 单次协调便于故障注入测试；Docker 不可用直接抛出，不虚构清理成功。
export async function superviseOnce(
  home: string,
  now = Date.now(),
): Promise<string[]> {
  const actions: string[] = [];
  const failures: unknown[] = [];
  for (const task of await listTasks(home)) {
    if (task.environmentId && !(await ownsRuntime(home, task))) continue;
    const lock = join(taskPath(home, task.id), "operation.lock");
    let lease: OperationLease | undefined;
    try {
      lease = JSON.parse(await readFile(lock, "utf8")) as OperationLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identity = lease ? await processIdentity(lease.pid) : undefined;
    const dead = !!lease && identity !== lease.identity;
    const expired = !!lease && Date.parse(lease.expiresAt) <= now;
    const abandoned =
      !lease &&
      ["queued", "preparing", "running", "collecting", "applying"].includes(
        task.state,
      ) &&
      Date.parse(task.updatedAt) + task.config.lifecycle.leaseSeconds * 1000 <=
        now;
    let policyFailure: string | undefined;
    if (
      !dead &&
      !expired &&
      !abandoned &&
      task.containerId &&
      task.networkId &&
      [
        "running",
        "preparing",
        "prepared",
        "checking",
        "ready",
        "awaiting_user",
      ].includes(task.state)
    ) {
      try {
        await refreshNetwork(home, task);
      } catch (error) {
        policyFailure = formatError(error);
      }
    }
    if (
      (dead || expired || abandoned || policyFailure) &&
      !["completed", "cleaned", "stopped", "interrupted"].includes(task.state)
    ) {
      try {
        await stopTaskResources(home, task, "supervisor");
      } catch (error) {
        const failure = policyFailure
          ? new AggregateError(
              [new Error(policyFailure), error],
              "隔离刷新与任务停止均失败",
            )
          : error;
        task.error = formatError(failure);
        if (
          !task.warnings.includes("监督停止未完全成功，不能确认整个任务已停止")
        )
          task.warnings.push("监督停止未完全成功，不能确认整个任务已停止");
        await saveTask(home, task);
        failures.push(failure);
        continue;
      }
      if (policyFailure) {
        task.error = policyFailure;
        task.warnings.push("网络策略刷新失败，已停止整个任务");
      }
      task.state = "interrupted";
      // 失联操作已停止；撤销交接身份，保留半写入标记供人工取回现场。
      delete task.recoveryPending;
      delete task.recoveryDispatch;
      delete task.workspaceOperation;
      task.interruptedAt = new Date(now).toISOString();
      task.expiresAt = new Date(
        now + task.config.lifecycle.interruptedRetentionHours * 3600000,
      ).toISOString();
      task.warnings.push(
        "监督器已停止失联任务；恢复仅保留文件，不恢复进程内存；部分应用须人工检查",
      );
      await saveTask(home, task);
      actions.push(`interrupted:${task.id}`);
    }
    if (dead && task.state === "interrupted") {
      try {
        await unlink(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (task.containerId && task.state !== "cleaned") {
      // 内容审计不可用只记录覆盖缺口，不停止正常开发或放宽网络边界。
      try {
        await refreshEnvironments(dockerClient(), home, task.id);
      } catch (error) {
        const warning = `通信审计核对失败，普通通信保持原边界：${formatError(error)}`;
        if (!task.warnings.includes(warning)) {
          task.warnings.push(warning);
          await saveTask(home, task);
        }
      }
      await startMonitor(home, task.id);
    }
  }
  actions.push(...(await collectGarbage(home, now)));
  if (failures.length)
    throw new AggregateError(failures, "部分任务未能确认停止");
  return actions;
}
// 恢复前重新安装网络策略，绝不直接启动未核验的开发进程。
export async function resumeTask(
  home: string,
  id: string,
  dispatchId?: string,
) {
  return withTaskLock(home, id, async () => {
    const task = await getTask(home, id);
    if (
      (dispatchId
        ? !(
            task.state === "queued" &&
            task.recoveryPending &&
            task.recoveryDispatch === dispatchId
          )
        : !["interrupted", "stopped", "failed"].includes(task.state)) ||
      !task.containerId ||
      !task.networkId
    )
      throw new Error("任务不可恢复");
    if (task.environmentReady === false)
      throw new Error(
        "首次准备尚未完成，不能恢复部分环境；请清理后重新创建任务",
      );
    const docker = dockerClient();
    try {
      task.recoveryPending = true;
      delete task.failureStage;
      await saveTask(home, task);
      const profile = profileSchema.parse(
        await readJson(join(taskPath(home, id), "profile.json")),
      );
      await claimEnvironment(home, task);
      // 先回收旧代理和旧进程，恢复只保留文件；不从最新宿主配置扩大授权。
      await stopTaskResources(home, task, "resume");
      if ((await taskProjectMode(home, task)) === "direct")
        await validateDirectRuntime(home, task, docker);
      task.state = "preparing";
      await saveTask(home, task);
      await restartTaskRuntime(home, task, profile, "resume");
    } catch (error) {
      let failure = error;
      try {
        await stopTaskResources(home, task, "failure");
      } catch (cleanup) {
        failure = new AggregateError(
          [error, cleanup],
          "恢复隔离失败且无法确认整个任务停止",
          { cause: error },
        );
      }
      task.state = "failed";
      delete task.recoveryPending;
      delete task.recoveryDispatch;
      task.error = formatError(failure);
      await saveTask(home, task);
      throw failure;
    }
    task.state = "prepared";
    delete task.recoveryPending;
    delete task.recoveryDispatch;
    task.environmentReady = true;
    delete task.error;
    delete task.failureStage;
    delete task.expiresAt;
    delete task.interruptedAt;
    await saveTask(home, task);
    await startMonitor(home, id);
    return task;
  });
}

// 监督器周期核对宿主地址；策略失效交给协调器停止任务。
async function refreshNetwork(home: string, task: Task): Promise<void> {
  const profile = profileSchema.parse(
    await readJson(join(taskPath(home, task.id), "profile.json")),
  );
  const info = await dockerClient().getContainer(task.containerId!).inspect();
  if (!info.State.Running) return;
  const policy = await readFrozenPolicy(home, task.id);
  await installPolicy(
    dockerClient(),
    task.containerId!,
    task.networkId!,
    profile.networkImage,
    task.config.network.hostAddresses,
    policy
      ? { mode: "default-open", grants: policy.network.grants }
      : undefined,
  );
}
