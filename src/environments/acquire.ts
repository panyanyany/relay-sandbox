import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Profile } from "../config/schema.js";
import type { FrozenPolicy, RuntimeOptions } from "../permissions/types.js";
import { policyDigest } from "../permissions/freeze.js";
import { digest } from "../storage/hash.js";
import { dockerClient } from "../docker/client.js";
import { createRuntime } from "../docker/runtime.js";
import { installPolicy } from "../network/policy.js";
import { prepareEnvironment } from "../tasks/environment.js";
import { saveTask } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { projectIdentity } from "../workspace/access.js";
import {
  readEnvironment,
  saveEnvironment,
  withEnvironmentLock,
  environmentPath,
} from "./store.js";
import { synchronizeWorkspace } from "./workspace.js";
import { preparePersistentAudit } from "./audit.js";

// 绑定运行边界而非prompt和交付策略；权限/镜像/挂载变化必须显式重置。
export async function environmentSignature(
  task: Task,
  profile: Profile,
  policy: FrozenPolicy,
) {
  return digest(
    JSON.stringify({
      projectRoot: task.projectRoot,
      identity: await projectIdentity(task.projectRoot),
      image: profile.image,
      networkImage: profile.networkImage,
      hostAddresses: task.config.network.hostAddresses,
      agent: task.config.developmentAgent.type,
      resources: task.config.resources,
      exclude: task.config.project.exclude,
      policy: policyDigest(policy),
    }),
  );
}
// 独占借用覆盖准备阶段；异常时保留活动归属，供取消/清理，不把半成品交给新任务。
export async function acquireEnvironment(
  home: string,
  task: Task,
  profile: Profile,
  policy: FrozenPolicy,
  options: RuntimeOptions,
) {
  return withEnvironmentLock(home, task.projectId, async () => {
    const signature = await environmentSignature(task, profile, policy);
    let environment = await readEnvironment(home, task.projectId);
    const reuse = !!environment;
    if (environment?.activeTaskId)
      throw new Error(
        `项目环境正由任务 ${environment.activeTaskId} 使用，请先收尾`,
      );
    if (environment?.needsReset)
      throw new Error("项目环境上次同步未完成，请显式重置后重试");
    if (environment && environment.signature !== signature)
      throw new Error(
        "项目环境的镜像、目录、挂载或权限边界已改变，请显式 environment-reset 后重试",
      );
    environment ??= {
      version: 1,
      id: randomUUID(),
      projectId: task.projectId,
      signature,
      mode: "persistent",
      idleRetentionHours: 24,
      createdAt: new Date().toISOString(),
    };
    task.environmentId = environment.id;
    environment.activeTaskId = task.id;
    environment.mode =
      task.config.environment.mode === "ttl" ? "ttl" : "persistent";
    environment.idleRetentionHours = task.config.environment.idleRetentionHours;
    delete environment.idleSince;
    await saveEnvironment(home, environment);
    await saveTask(home, task);
    const docker = dockerClient();
    // 项目资源副本留在环境目录，任务清理不能删除仍被容器挂载的源。
    const persistentOptions = await prepareEnvironment(
      home,
      task,
      policy,
      reuse,
      join(environmentPath(home, task.projectId), "resources"),
    );
    const mainMount =
      options.mounts?.filter((mount) => mount.Target === "/workspace") ?? [];
    if (reuse) {
      if (!environment.containerId || !environment.networkId)
        throw new Error("项目环境创建未完成，请显式重置或检查现场");
      task.containerId = environment.containerId;
      task.networkId = environment.networkId;
      const info = await docker.getContainer(task.containerId).inspect();
      if (
        info.Config.Labels?.["relay-sandbox.task"] !== environment.id ||
        info.State.Running
      )
        throw new Error("持久环境归属或空闲状态异常，拒绝复用");
      await docker.getContainer(task.containerId).start();
      await installPolicy(
        docker,
        task.containerId,
        task.networkId,
        profile.networkImage,
        task.config.network.hostAddresses,
        options.network,
      );
      task.warnings.push(
        `复用项目环境 ${environment.id}；历史软件及用户配置仍保留，历史风险不能视为已消除`,
      );
    } else {
      const runtime = await createRuntime(
        docker,
        environment.id,
        profile.image,
        profile.networkImage,
        task.config,
        environment.id,
        {
          ...persistentOptions,
          mounts: [...(persistentOptions.mounts ?? []), ...mainMount],
        },
      );
      Object.assign(task, runtime);
      Object.assign(environment, runtime);
      await saveEnvironment(home, environment);
    }
    await saveTask(home, task);
    environment.needsReset = true;
    await saveEnvironment(home, environment);
    await synchronizeWorkspace(home, task, reuse);
    environment.needsReset = false;
    await saveEnvironment(home, environment);
    return preparePersistentAudit(home, task, policy);
  });
}
