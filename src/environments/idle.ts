import { withFinalizer } from "../storage/finalize.js";
import { join } from "node:path";
import { readJson } from "../storage/files.js";
import { profileSchema } from "../config/schema.js";
import { taskPath } from "../tasks/store.js";
import { restartTaskRuntime } from "../tasks/restart.js";
import { synchronizeWorkspace } from "./workspace.js";
import {
  readEnvironment,
  saveEnvironment,
  withEnvironmentLock,
} from "./store.js";
import { dockerClient } from "../docker/client.js";
import { removeRuntime } from "../docker/runtime.js";
import { stopTaskResources } from "../tasks/cleanup.js";
import { stopMonitor } from "../monitoring/monitor.js";
import type { Task } from "../tasks/types.js";
import { rememberPersistentAudit } from "./audit.js";
import { ownsRuntime, releaseEnvironment } from "./ownership.js";

// 任务完成只停止和释放环境；报告、备份和持久文件分别遵循各自保留规则。
export async function idleEnvironment(home: string, task: Task) {
  if (!task.environmentId) {
    if (
      task.config.environment?.mode !== "ephemeral" ||
      !task.containerId ||
      !task.networkId
    )
      return;
    await stopTaskResources(home, task, "delivery");
    await stopMonitor(home, task.id);
    const docker = dockerClient();
    const failures: unknown[] = [];
    for (const container of await docker.listContainers({
      all: true,
      filters: { label: [`relay-sandbox.task=${task.id}`] },
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
      throw new AggregateError(failures, "临时环境容器销毁不完整");
    await removeRuntime(docker, {
      containerId: task.containerId,
      networkId: task.networkId,
    });
    return;
  }
  if (!(await ownsRuntime(home, task))) return;
  // 成功交付后推进宿主共同基线，避免下一任务复活用户已删除的上轮产出。
  if (task.projectMode !== "direct" && task.state === "completed") {
    await withEnvironmentLock(home, task.projectId, async () => {
      const environment = (await readEnvironment(home, task.projectId))!;
      environment.needsReset = true;
      await saveEnvironment(home, environment);
      const profile = profileSchema.parse(
        await readJson(join(taskPath(home, task.id), "profile.json")),
      );
      await restartTaskRuntime(home, task, profile, "delivery", false);
      // 错误示范：直接在 finally 抛错会覆盖同步错误；统一保留两个原因。
      await withFinalizer(
        () => synchronizeWorkspace(home, task, true, true),
        () => stopTaskResources(home, task, "delivery"),
      );
      environment.needsReset = false;
      await saveEnvironment(home, environment);
    });
  }
  await stopTaskResources(home, task, "delivery");
  await stopMonitor(home, task.id);
  await rememberPersistentAudit(home, task);
  await releaseEnvironment(home, task);
}
