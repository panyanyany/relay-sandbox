import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FrozenPolicy, RuntimeOptions } from "../permissions/types.js";
import {
  loadPreparedResources,
  prepareResources,
} from "../resources/prepare.js";
import { environmentPath } from "../environments/store.js";
import { requireRuntimeOwner } from "../environments/ownership.js";
import { dockerClient } from "../docker/client.js";
import { prepareEnvironment } from "./environment.js";
import { taskPath } from "./store.js";
import type { Task } from "./types.js";

// 检查冻结实际开发资源；独立副本防止测试改写持久环境，直接授权保持原语义。
export async function prepareCheckResources(
  home: string,
  task: Task,
  policy: FrozenPolicy | undefined,
): Promise<RuntimeOptions> {
  if (!task.environmentId || !policy)
    return prepareEnvironment(home, task, policy, true);
  await requireRuntimeOwner(home, task);
  if (!task.containerId) throw new Error("持久环境缺少容器标识");
  if (
    (await dockerClient().getContainer(task.containerId).inspect()).State
      .Running
  )
    throw new Error("检查前必须停止持久开发环境，避免资源在冻结时变化");
  const options = await prepareEnvironment(
    home,
    task,
    policy,
    true,
    join(environmentPath(home, task.projectId), "resources"),
  );
  const actual = await loadPreparedResources(
    policy.resources,
    join(environmentPath(home, task.projectId), "resources"),
    [home, task.projectRoot],
  );
  const destination = join(taskPath(home, task.id), "check-resources");
  await rm(destination, { recursive: true, force: true });
  // 错误示范：使用宿主重新复制的任务资源会让检查读到与开发不同的内容。
  const frozen = await prepareResources(actual.resources, destination);
  return { ...options, mounts: frozen.mounts };
}
