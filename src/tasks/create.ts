import {
  preparationControl,
  PreparationCancelled,
} from "./preparation-control.js";
import { withPreparationDockerTimeout } from "../docker/preparation-timeout.js";
import { readFrozenPolicy } from "../permissions/freeze.js";
import { profileSchema } from "../config/schema.js";
import { readJson } from "../storage/files.js";
import { withTaskLock } from "./lock.js";
import { readCredential } from "../config/credentials.js";
import { formatError } from "../audit/redaction.js";
import { acquireEnvironment } from "../environments/acquire.js";
import { stopTaskResources } from "./cleanup.js";
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
import { getTask, saveTask, taskPath } from "./store.js";
import type { Task } from "./types.js";
import {
  projectMode,
  projectMounts,
  projectIdentity,
} from "../workspace/access.js";
// 创建时冻结配置，模型不能通过修改项目文件改变当前交付条件。
export async function reserveTask(
  home: string,
  projectId: string,
  prompt: string,
): Promise<Task> {
  if (!prompt.trim()) throw new Error("任务内容不能为空");
  const projectRoot = await resolveProject(home, projectId);
  const config = await loadConfig(projectRoot);
  const profile = await loadProfile(home, config.developmentAgent.profile);
  const credential = await readCredential(home, profile);
  if (!credential)
    throw new Error(
      `缺少专用中转站凭据: ${profile.apiKeyEnv}；请使用配置查询返回的本机credential-set命令`,
    );
  const id = randomUUID(),
    now = new Date().toISOString();
  const task: Task = {
    id,
    projectId,
    projectRoot,
    ...(process.env.RELAY_TERMINAL_SESSION_ID
      ? { terminalSessionId: process.env.RELAY_TERMINAL_SESSION_ID }
      : {}),
    prompt,
    config,
    configDigest: configDigest(config),
    state: "preparing",
    environmentReady: false,
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
    task.projectMode = projectMode(policy);
    await writeJson(join(taskPath(home, id), "profile.json"), profile);
    await saveTask(home, task);
    return task;
  } catch (error) {
    task.state = "failed";
    task.error = formatError(error, [credential.key]);
    await saveTask(home, task);
    throw error;
  }
}
// 后台进程只使用创建时冻结的配置、档案与授权，并持有任务租约。
export async function prepareTask(home: string, id: string): Promise<Task> {
  return withPreparationDockerTimeout(() =>
    withTaskLock(home, id, async () => {
      const task = await getTask(home, id);
      if (task.state !== "preparing" || task.environmentReady !== false)
        throw new Error("任务状态不允许准备环境");
      const { projectRoot, config } = task;
      let secret = "";
      let control: Awaited<ReturnType<typeof preparationControl>> | undefined;
      // 长步骤结束后核对停止状态，不能把停止或清理中的任务重新标成就绪。
      const active = async () => {
        await control?.check();
        if ((await getTask(home, id)).state !== "preparing")
          throw new Error("环境准备已被停止");
      };
      try {
        control = await preparationControl(home, id);
        const profile = profileSchema.parse(
          await readJson(join(taskPath(home, id), "profile.json")),
        );
        const credential = await readCredential(home, profile);
        if (!credential) throw new Error("专用中转站凭据不可用");
        secret = credential.key;
        const policy = await readFrozenPolicy(home, id);
        if (!policy) throw new Error("缺少创建时冻结的任务授权");
        const mounts = await projectMounts(home, projectRoot, config, policy);
        if (task.projectMode === "direct") {
          task.projectIdentity = await projectIdentity(projectRoot);
          task.warnings.push(
            "原项目直接挂载：开发期间写入和删除立即生效，交付检查只作事后检查，不自动回滚",
          );
          await active();
          await saveTask(home, task);
        }
        const baseline = await snapshot(
          projectRoot,
          join(taskPath(home, id), "baseline"),
          config.project.exclude,
          Infinity,
          control.signal,
        );
        await active();
        await writeJson(join(taskPath(home, id), "baseline.json"), baseline);
        const options = await prepareEnvironment(home, task, policy, false);
        options.mounts = [...(options.mounts ?? []), ...(mounts ?? [])];
        await active();
        let auditReady = true;
        if (config.environment.mode !== "ephemeral") {
          auditReady = await acquireEnvironment(
            home,
            task,
            profile,
            policy,
            options,
          );
        } else {
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
          await active();
          await saveTask(home, task);
          if (task.projectMode !== "direct")
            await upload(
              dockerClient(),
              handle.containerId,
              join(taskPath(home, id), "baseline"),
            );
        }
        await active();
        if (auditReady)
          await installEnvironment(dockerClient(), {
            home,
            taskId: id,
            runtimeId: id,
            containerId: task.containerId!,
            policy,
            role: "main",
          });
        await active();
        await startMonitor(home, id);
        await active();
        task.environmentReady = true;
        task.state = "prepared";
        await saveTask(home, task);
        return task;
      } catch (error) {
        if (task.environmentId || task.containerId) {
          try {
            await stopTaskResources(home, task, "failure");
          } catch (cleanup) {
            error = new AggregateError(
              [error, cleanup],
              "环境准备失败且无法确认停止",
              { cause: error },
            );
          }
        }
        const current = await getTask(home, id);
        if (["stopped", "interrupted", "cleaned"].includes(current.state))
          throw error;
        task.state =
          error instanceof PreparationCancelled ? "stopped" : "failed";
        task.environmentReady = false;
        // 保留准备与收尾的完整脱敏原因链，不能只存 AggregateError 的标题。
        task.error = formatError(error, [secret]);
        await saveTask(home, task);
        if (error instanceof PreparationCancelled) return task;
        throw error;
      } finally {
        await control?.close();
      }
    }),
  );
}

// CLI及内部调用保留同步创建语义；MCP使用reserveTask后派发后台准备。
export async function createTask(
  home: string,
  project: string,
  prompt: string,
) {
  const task = await reserveTask(home, project, prompt);
  return prepareTask(home, task.id);
}
