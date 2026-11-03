import { requireEnvironmentReady } from "./readiness.js";
import { readCredential } from "../config/credentials.js";
import { requireRuntimeOwner } from "../environments/ownership.js";
import { withTaskLock } from "./lock.js";
import { trafficGuidance } from "../traffic/guidance.js";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { dockerClient } from "../docker/client.js";
import { execute } from "../docker/execute.js";
import { download } from "../docker/archive.js";
import { profileSchema } from "../config/schema.js";
import { readJson } from "../storage/files.js";
import { startAudit } from "../audit/collector.js";
import { developmentAdapter } from "../agents/development/adapters.js";
import { writeJson } from "../storage/files.js";
import { scan, manifestDigest } from "../workspace/manifest.js";

import { getTask, saveTask, taskPath } from "./store.js";
import { formatError } from "../audit/redaction.js";
import { withFinalizer } from "../storage/finalize.js";
import type { Task } from "./types.js";
import { taskProjectMode, validateDirectRuntime } from "../workspace/access.js";
import { MAX_EXPORT_FILE_BYTES } from "../workspace/stable-file.js";
import { snapshot } from "../workspace/snapshot.js";
import { stopTaskResources } from "./cleanup.js";
import { restartTaskRuntime } from "./restart.js";
import { startDirectProject } from "./direct-project.js";
// 重新收集时销毁旧的宿主结果目录，不复用可能含链接的旧导出目标。
export async function collectTask(home: string, task: Task): Promise<Task> {
  if (!task.containerId) throw new Error("任务没有容器");
  await requireRuntimeOwner(home, task);
  const current = await getTask(home, task.id);
  if (["stopped", "interrupted", "cleaned"].includes(current.state))
    throw new Error("任务已停止，不再收集");
  task.deliveryPrepared = false;
  task.state = "collecting";
  await saveTask(home, task);
  const root = taskPath(home, task.id);
  const result = join(root, "result");
  await rm(result, { recursive: true, force: true });
  if ((await taskProjectMode(home, task)) === "direct") {
    try {
      await stopTaskResources(home, task);
      await validateDirectRuntime(home, task, dockerClient());
      await snapshot(task.projectRoot, result, [], MAX_EXPORT_FILE_BYTES);
    } catch (error) {
      task.state = "failed";
      task.error = formatError(error);
      await saveTask(home, task);
      throw error;
    }
  } else {
    if (task.environmentId) await stopTaskResources(home, task);
    await download(dockerClient(), task.containerId, result);
  }
  const manifest = await scan(result);
  task.artifactDigest = manifestDigest(manifest);
  delete task.review;
  task.checks = [];
  await writeJson(join(root, "result.json"), manifest);

  if (
    ["stopped", "interrupted", "cleaned"].includes(
      (await getTask(home, task.id)).state,
    )
  )
    throw new Error("收集期间任务已停止");
  task.state = "checking";
  await saveTask(home, task);
  return task;
}
async function runTaskLocked(
  home: string,
  id: string,
  prompt?: string,
): Promise<Task> {
  const task = await getTask(home, id);
  requireEnvironmentReady(task);
  await requireRuntimeOwner(home, task);
  const containerId = task.containerId;
  if (!containerId) throw new Error("任务没有运行环境");
  if (
    [
      "stopped",
      "interrupted",
      "running",
      "applying",
      "completed",
      "cleaned",
    ].includes(task.state)
  )
    throw new Error(`状态不允许运行: ${task.state}`);
  const profile = profileSchema.parse(
    await readJson(join(taskPath(home, id), "profile.json")),
  );
  const key = (await readCredential(home, profile))?.key;
  if (!key) throw new Error("专用中转站凭据不可用");
  if ((await taskProjectMode(home, task)) === "direct")
    await startDirectProject(home, task, profile);
  else if (
    task.environmentId &&
    !(await dockerClient().getContainer(containerId).inspect()).State.Running
  )
    await restartTaskRuntime(home, task, profile, "rework");
  // 保留本轮用户需求，附加可选入口说明，不改任务原始prompt记录。
  const guidance = await trafficGuidance(home, id);
  const effectivePrompt = `${prompt ?? task.prompt}\n\n${guidance}`;
  const spec = developmentAdapter(task.config.developmentAgent.type).launch(
    effectivePrompt,
    profile,
    key,
  );
  task.state = "running";
  task.round++;
  await saveTask(home, task);
  const audit = await startAudit(
    dockerClient(),
    containerId,
    id,
    join(taskPath(home, id), "audit-events.jsonl"),
    [key],
  );
  return withFinalizer(
    async () => {
      try {
        const result = await execute(
          dockerClient(),
          containerId,
          spec.argv,
          spec.env,
          task.config.lifecycle.taskTimeoutMinutes * 60000,
          task.config.resources.maxOutputBytes,
          [key],
        );
        await writeFile(
          join(taskPath(home, id), `round-${task.round}.log`),
          result.output,
          { mode: 0o600 },
        );
        if (result.exitCode !== 0)
          throw new Error(
            `开发 Agent 退出码 ${result.exitCode}，请检查脱敏日志`,
          );
        if (result.truncated) task.warnings.push("开发日志超过上限，已截断");
        return await collectTask(home, task);
      } catch (error) {
        const current = await getTask(home, id);
        if (["stopped", "interrupted", "cleaned"].includes(current.state))
          throw error;
        task.state = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        await saveTask(home, task);
        throw error;
      }
    },
    async () => {
      const report = await audit.finish();
      await writeJson(
        join(taskPath(home, id), `audit-round-${task.round}.json`),
        report,
      );
      await writeJson(join(taskPath(home, id), "audit.json"), report);
    },
  );
}

// 宿主并发入口共享任务互斥边界。
export async function runTask(home: string, id: string, prompt?: string) {
  requireEnvironmentReady(await getTask(home, id));
  return withTaskLock(home, id, async () => {
    requireEnvironmentReady(await getTask(home, id));
    try {
      return await runTaskLocked(home, id, prompt);
    } catch (error) {
      const task = await getTask(home, id);
      if (
        !["stopped", "interrupted", "cleaned", "completed"].includes(task.state)
      ) {
        if (task.environmentId) {
          try {
            await stopTaskResources(home, task);
          } catch (cleanup) {
            error = new AggregateError(
              [error, cleanup],
              "开发失败且无法确认环境停止",
              { cause: error },
            );
          }
        }
        task.state = "failed";
        task.error = formatError(error);
        await saveTask(home, task);
      }
      throw error;
    }
  });
}
