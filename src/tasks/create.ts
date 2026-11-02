import { freezeEnvironment, prepareEnvironment } from "./environment.js";
import { installEnvironment } from "./environment-install.js";
import { startMonitor } from "../monitoring/monitor.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveProject } from "../projects/registry.js";
import { loadConfig, loadProfile, configDigest } from "../config/load.js";
import { snapshot } from "../workspace/snapshot.js";
import { writeJson } from "../storage/files.js";
import { dockerClient } from "../docker/client.js";
import { createRuntime } from "../docker/runtime.js";
import { upload } from "../docker/archive.js";
import { saveTask, taskPath } from "./store.js";
import type { Task } from "./types.js";
// 创建时冻结配置，模型不能通过修改项目文件改变当前交付条件。
export async function createTask(
  home: string,
  projectId: string,
  prompt: string,
): Promise<Task> {
  if (!prompt.trim()) throw new Error("任务内容不能为空");
  const projectRoot = await resolveProject(home, projectId);
  const config = await loadConfig(projectRoot);
  const profile = await loadProfile(home, config.developmentAgent.profile);
  if (!process.env[profile.apiKeyEnv])
    throw new Error(`缺少专用中转站凭据环境变量: ${profile.apiKeyEnv}`);
  const id = randomUUID(),
    now = new Date().toISOString();
  const task: Task = {
    id,
    projectId,
    projectRoot,
    prompt,
    config,
    configDigest: configDigest(config),
    state: "preparing",
    deliveryPrepared: false,
    applicationStatus: "not_attempted",
    createdAt: now,
    updatedAt: now,
    round: 0,
    checks: [],
    warnings: [
      "内核审计仅部分覆盖；磁盘硬配额未启用；异常监督需独立运行 supervise",
    ],
  };
  await saveTask(home, task);
  try {
    const { policy, configDigest: frozenDigest } = await freezeEnvironment(
      home,
      id,
      projectId,
      config,
    );
    task.configDigest = frozenDigest;
    await saveTask(home, task);
    await writeJson(join(taskPath(home, id), "profile.json"), profile);
    const baseline = await snapshot(
      projectRoot,
      join(taskPath(home, id), "baseline"),
      config.project.exclude,
    );
    await writeJson(join(taskPath(home, id), "baseline.json"), baseline);
    const options = await prepareEnvironment(home, task, policy, false);
    const handle = await createRuntime(
      dockerClient(),
      id,
      profile.image,
      profile.networkImage,
      config,
      id,
      options,
    );
    Object.assign(task, handle);
    await saveTask(home, task);
    await upload(
      dockerClient(),
      handle.containerId,
      join(taskPath(home, id), "baseline"),
    );
    await installEnvironment(dockerClient(), {
      home,
      taskId: id,
      runtimeId: id,
      containerId: handle.containerId,
      policy,
      role: "main",
    });
    await startMonitor(home, id);
    return task;
  } catch (error) {
    task.state = "failed";
    task.error = error instanceof Error ? error.message : String(error);
    await saveTask(home, task);
    throw error;
  }
}
