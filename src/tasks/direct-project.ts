import { requireRuntimeOwner } from "../environments/ownership.js";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { validateDirectRuntime } from "../workspace/access.js";
import { manifestDigest, scan } from "../workspace/manifest.js";
import { MAX_EXPORT_FILE_BYTES } from "../workspace/stable-file.js";
import { snapshot } from "../workspace/snapshot.js";
import { dockerClient } from "../docker/client.js";
import type { Profile } from "../config/schema.js";
import type { Task } from "./types.js";
import { taskPath } from "./store.js";
import { stopTaskResources } from "./cleanup.js";
import { restartTaskRuntime } from "./restart.js";

// 事后检查前停止整个任务的写入进程；返工仍可显式重新启动原开发容器。
export async function prepareDirectProject(home: string, task: Task) {
  // 错误示范：先遍历目录再停止，遇到FIFO等异常会留下仍可写入的进程。
  await stopTaskResources(home, task, "delivery");
  await validateDirectRuntime(home, task, dockerClient());
  const root = taskPath(home, task.id);
  const current = await snapshot(
    task.projectRoot,
    join(root, "current"),
    [],
    MAX_EXPORT_FILE_BYTES,
  );
  if (manifestDigest(current) !== task.artifactDigest)
    throw new Error(
      "原项目在结果收集后发生变化，请重新运行开发并收集结果后检查",
    );
  await cp(join(root, "result"), join(root, "candidate"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

// 错误示范：直接模式再调用applyChanges，会把事后检查误当成写入前屏障。
export async function confirmDirectProject(home: string, task: Task) {
  // 错误示范：先遍历目录再停止，遇到FIFO等异常会留下仍可写入的进程。
  await stopTaskResources(home, task, "delivery");
  await validateDirectRuntime(home, task, dockerClient());
  if (
    manifestDigest(await scan(task.projectRoot, [], MAX_EXPORT_FILE_BYTES)) !==
    task.artifactDigest
  )
    throw new Error("原项目已偏离检查候选，不能确认检查通过；请重新收集和检查");
}

// 返工只启动原挂载，重新安装冻结网络；不重新加载宿主授权或修改宿主所有者。
export async function startDirectProject(
  home: string,
  task: Task,
  profile: Profile,
) {
  await requireRuntimeOwner(home, task);
  const docker = dockerClient();
  await validateDirectRuntime(home, task, docker);
  const container = docker.getContainer(task.containerId!);
  if ((await container.inspect()).State.Running) return;
  await restartTaskRuntime(home, task, profile, "rework");
}
