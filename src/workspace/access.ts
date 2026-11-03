import type Docker from "dockerode";
import { lstat } from "node:fs/promises";
import type { Config } from "../config/schema.js";
import type { FrozenPolicy, RuntimeOptions } from "../permissions/types.js";
import { readFrozenPolicy } from "../permissions/freeze.js";
import { validateSourceDirectory } from "../resources/paths.js";
import type { Task } from "../tasks/types.js";

// 模式只取自可信宿主快照；旧快照没有字段时继续使用独立副本。
export function projectMode(policy: FrozenPolicy | undefined) {
  return policy?.project?.mode ?? "isolated";
}

// 同时核对诊断副本；丢失直接授权时明确失败，不能假装该任务一直隔离。
export async function taskProjectMode(
  home: string,
  task: Pick<Task, "id" | "projectMode">,
) {
  const mode = projectMode(await readFrozenPolicy(home, task.id));
  if (task.projectMode !== undefined && task.projectMode !== mode)
    throw new Error("项目访问模式与冻结授权不一致，不能继续运行或交付");
  return mode;
}

// 记录目录身份，避免同一路径在任务运行期间被换成另一个项目目录。
export async function projectIdentity(root: string) {
  const info = await lstat(root, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

// 错误示范：bind mount不支持按glob隐藏文件，不能静默忽略排除规则。
export async function projectMounts(
  home: string,
  root: string,
  config: Config,
  policy: FrozenPolicy,
): Promise<RuntimeOptions["mounts"]> {
  if (projectMode(policy) !== "direct") return [];
  if (config.project.exclude.length)
    throw new Error(
      "直接挂载原项目不支持 project.exclude，请使用隔离模式或显式移除排除规则",
    );
  // 链接只在容器命名空间解析；宿主快照保留链接而不读取其目标。
  await validateSourceDirectory(root, [home], { allowSymlinks: true });
  return [
    {
      Type: "bind",
      Source: root,
      Target: "/workspace",
      ReadOnly: false,
      BindOptions: { Propagation: "rprivate" },
    },
  ];
}

// 恢复和返工验证原挂载，不因最新宿主配置或路径替换而悄悄换源。
export async function validateDirectRuntime(
  home: string,
  task: Task,
  docker: Docker,
) {
  const policy = await readFrozenPolicy(home, task.id);
  const mode = projectMode(policy);
  if (task.projectMode !== undefined && task.projectMode !== mode)
    throw new Error("项目访问模式与冻结授权不一致，不能继续运行或交付");
  if (mode !== "direct") return false;
  await projectMounts(home, task.projectRoot, task.config, policy!);
  if (task.projectIdentity !== (await projectIdentity(task.projectRoot)))
    throw new Error("原项目目录已被替换，不能继续使用旧挂载");
  const info = await docker.getContainer(task.containerId!).inspect();
  const mounted = info.Mounts?.find(
    (mount) => mount.Destination === "/workspace",
  );
  if (
    mounted?.Type !== "bind" ||
    mounted.Source !== task.projectRoot ||
    !mounted.RW
  )
    throw new Error("开发容器的原项目挂载与冻结任务不一致");
  return true;
}
