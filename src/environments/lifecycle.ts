import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dockerClient } from "../docker/client.js";
import { removeRuntime, stopRuntime } from "../docker/runtime.js";
import {
  readEnvironment,
  environmentPath,
  withEnvironmentLock,
} from "./store.js";

// 删除只处理环境稳定标签；活动任务必须先取消和清理，防止重置时丢失未收集结果。
export async function deleteEnvironment(
  home: string,
  projectId: string,
  expiredAt?: number,
) {
  return withEnvironmentLock(home, projectId, async () => {
    const environment = await readEnvironment(home, projectId);
    if (!environment) return { projectId, status: "absent" };
    if (
      expiredAt !== undefined &&
      (environment.mode !== "ttl" ||
        !environment.idleSince ||
        Date.parse(environment.idleSince) +
          environment.idleRetentionHours * 3600000 >
          expiredAt ||
        environment.activeTaskId)
    )
      return { projectId, status: "not_expired" };
    if (environment.activeTaskId)
      throw new Error(
        `环境仍由任务 ${environment.activeTaskId} 占用，请先 cleanup 任务`,
      );
    const docker = dockerClient();
    // 先核对所有登记身份；记录损坏不能据此删除其他项目资源。
    if (environment.containerId) {
      try {
        const info = await docker
          .getContainer(environment.containerId)
          .inspect();
        if (info.Config.Labels?.["relay-sandbox.task"] !== environment.id)
          throw new Error("环境容器归属不一致");
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    if (environment.networkId) {
      try {
        const info = await docker.getNetwork(environment.networkId).inspect();
        if (info.Labels?.["relay-sandbox.task"] !== environment.id)
          throw new Error("环境网络归属不一致");
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    const failures: unknown[] = [];
    for (const container of await docker.listContainers({
      all: true,
      filters: { label: [`relay-sandbox.task=${environment.id}`] },
    })) {
      try {
        await docker
          .getContainer(container.Id)
          .remove({ force: true, v: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404)
          failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "环境容器删除不完整");
    if (environment.containerId && environment.networkId)
      await removeRuntime(docker, {
        containerId: environment.containerId,
        networkId: environment.networkId,
      });
    // 保留锁本身到finally，资源全部回收成功后才移除环境记录和私密副本。
    for (const name of await readdir(environmentPath(home, projectId)))
      if (name !== "operation.lock")
        await rm(join(environmentPath(home, projectId), name), {
          recursive: true,
          force: true,
        });
    return { projectId, status: "deleted" };
  });
}
// 空闲环境停止不改变任务记录；活动环境由统一任务取消入口处理。
export async function stopProjectEnvironment(home: string, projectId: string) {
  const environment = await readEnvironment(home, projectId);
  if (environment?.activeTaskId)
    throw new Error(
      `环境有活动任务 ${environment.activeTaskId}，请 cancel 该任务`,
    );
  return withEnvironmentLock(home, projectId, async () => {
    const current = await readEnvironment(home, projectId);
    if (current?.activeTaskId) throw new Error("环境已被任务借用，请取消任务");
    if (current?.containerId) {
      const docker = dockerClient();
      const info = await docker.getContainer(current.containerId).inspect();
      if (info.Config.Labels?.["relay-sandbox.task"] !== current.id)
        throw new Error("环境容器归属不一致");
      await stopRuntime(docker, current.containerId);
    }
    return { projectId, status: current ? "stopped" : "absent" };
  });
}
// TTL仅从成功释放的空闲时间计算；永久环境不进入删除计划。
export async function expiredEnvironments(home: string, now = Date.now()) {
  let projects: string[];
  try {
    projects = await readdir(join(home, "environments"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const projectId of projects) {
    const environment = await readEnvironment(home, projectId);
    if (
      environment?.mode === "ttl" &&
      !environment.activeTaskId &&
      environment.idleSince &&
      Date.parse(environment.idleSince) +
        environment.idleRetentionHours * 3600000 <=
        now
    )
      result.push(projectId);
  }
  return result;
}
