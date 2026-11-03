import { withFinalizer } from "../storage/finalize.js";
import { randomUUID } from "node:crypto";
import { dockerClient } from "../docker/client.js";
import { installPolicy } from "../network/policy.js";
import { readFrozenPolicy } from "../permissions/freeze.js";
import { formatError } from "../audit/redaction.js";
import type { Profile } from "../config/schema.js";
import type { Task } from "./types.js";
import { stopTaskResources } from "./cleanup.js";
import { installEnvironment } from "./environment-install.js";
import { saveTask } from "./store.js";
import { synchronizeResumedWorkspace } from "./resume-workspace.js";

// 恢复与返工共用强制网络、可选审计及失败收尾规则；调用方先核对挂载。
export async function restartTaskRuntime(
  home: string,
  task: Task,
  profile: Profile,
  reason: "resume" | "rework" | "delivery",
  observe = true,
) {
  const docker = dockerClient();
  const policy = await readFrozenPolicy(home, task.id);
  return withFinalizer(
    async () => {
      try {
        if (reason !== "delivery") {
          task.workspaceOperation = true;
          await saveTask(home, task);
        }
        await docker.getContainer(task.containerId!).start();
        await installPolicy(
          docker,
          task.containerId!,
          task.networkId!,
          profile.networkImage,
          task.config.network.hostAddresses,
          policy
            ? { mode: "default-open", grants: policy.network.grants }
            : undefined,
        );
        // 交付收尾的内部启动由 idleEnvironment 自行同步，不能再次取环境锁或使审核失效。
        if (reason !== "delivery")
          await synchronizeResumedWorkspace(home, task);
        if (policy && observe) {
          try {
            await installEnvironment(docker, {
              home,
              taskId: task.id,
              runtimeId: `${task.id}-${reason}-${randomUUID().slice(0, 8)}`,
              containerId: task.containerId!,
              policy,
              role: "main",
            });
          } catch (error) {
            // 错误示范：返工直接抛出可选审计故障，会留下半启动容器且与恢复行为分叉。
            task.warnings.push(
              `通信审计不可用，开发继续：${formatError(error)}`,
            );
          }
        }
        // 降级记录无法持久化属于致命失败，不能静默继续。
        await saveTask(home, task);
      } catch (error) {
        try {
          await stopTaskResources(home, task, "failure");
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "重启失败且无法确认整个任务停止",
            { cause: error },
          );
        }
        throw error;
      }
    },
    async () => {
      if (reason !== "delivery") {
        delete task.workspaceOperation;
        await saveTask(home, task);
      }
    },
  );
}
