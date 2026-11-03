import {
  expiredEnvironments,
  deleteEnvironment,
} from "../environments/lifecycle.js";
import { readdir, unlink, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getTask, listTasks, saveTask, taskPath } from "./store.js";
import { processIdentity, type OperationLease } from "./lock.js";
import { cleanupTask } from "./cleanup.js";
import { environmentDirectory } from "./environment-state.js";
import { pruneTelemetry } from "../monitoring/log-store.js";

// 清理计划仅引用本状态目录的已登记任务，不扫描或删除其他项目资源。
export async function garbageCollectionPlan(home: string, now = Date.now()) {
  const plan = [];
  for (const task of await listTasks(home)) {
    let active = false;
    try {
      const lease = JSON.parse(
        await readFile(join(taskPath(home, task.id), "operation.lock"), "utf8"),
      ) as OperationLease;
      active = (await processIdentity(lease.pid)) === lease.identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (active) continue;
    const files = await pruneTelemetry(
      join(taskPath(home, task.id), "telemetry"),
      task.config.logging.retentionDays,
      now,
      true,
    );
    if (files.length)
      plan.push({
        taskId: task.id,
        action: "prune_telemetry" as const,
        reason: "telemetry_expired",
        files,
      });
    const interrupted =
      task.state === "interrupted" &&
      task.expiresAt &&
      Date.parse(task.expiresAt) <= now;
    const finished =
      ["completed", "failed", "stopped"].includes(task.state) &&
      Date.parse(task.updatedAt) +
        task.config.lifecycle.finishedRetentionHours * 3600000 <=
        now;
    if (interrupted || finished)
      plan.push({
        taskId: task.id,
        action: "cleanup_resources" as const,
        reason: interrupted ? "interrupted_expired" : "finished_expired",
      });
    if (
      task.state === "cleaned" &&
      task.cleanedAt &&
      !task.reportsPurgedAt &&
      Date.parse(task.cleanedAt) +
        task.config.audit.reportRetentionDays * 86400000 <=
        now
    )
      plan.push({
        taskId: task.id,
        action: "purge_reports" as const,
        reason: "reports_expired",
      });
  }
  return [
    ...plan,
    ...(await expiredEnvironments(home, now)).map((projectId) => ({
      projectId,
      action: "delete_environment" as const,
      reason: "environment_idle_expired",
    })),
  ];
}

// 正常收尾保留证据，到期再删除日志和用户报告；代码备份及任务元数据始终保留。
export async function collectGarbage(home: string, now = Date.now()) {
  const actions: string[] = [];
  for (const item of await garbageCollectionPlan(home, now)) {
    if (item.action === "delete_environment") {
      const result = await deleteEnvironment(home, item.projectId, now);
      if (result.status === "deleted")
        actions.push(`environment-deleted:${item.projectId}`);
    } else if (item.action === "cleanup_resources") {
      await cleanupTask(home, item.taskId);
      actions.push(`cleaned:${item.taskId}`);
    } else if (item.action === "purge_reports") {
      const task = await getTask(home, item.taskId),
        root = taskPath(home, item.taskId);
      for (const name of await readdir(root))
        if (
          /^audit(?:-round-\d+|-events)?\.jsonl?(?:\.\d+)?$/.test(name) ||
          /^round-\d+\.log$/.test(name) ||
          /^(?:worker|monitor-worker)\.log$/.test(name) ||
          /^user-report(?:-emission)?\.json$/.test(name)
        )
          await unlink(join(root, name));
      // 到期只删最小通信证据，保留每运行时summary与代码备份。
      const errors: unknown[] = [];
      const entries = await readdir(join(root, "traffic"), {
        withFileTypes: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        try {
          if (entry.isFile()) continue;
          if (!entry.isDirectory())
            throw new Error(`通信运行时必须为真实目录：${entry.name}`);
          const environment = environmentDirectory(home, task.id, entry.name);
          for (const part of ["evidence", "diagnostics"])
            await rm(join(environment, part), { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "部分过期通信证据未能回收");
      task.reportsPurgedAt = new Date(now).toISOString();
      await saveTask(home, task);
      actions.push(`reports-purged:${item.taskId}`);
    } else {
      const task = await getTask(home, item.taskId);
      const removed = await pruneTelemetry(
        join(taskPath(home, task.id), "telemetry"),
        task.config.logging.retentionDays,
        now,
      );
      actions.push(`telemetry-pruned:${item.taskId}:${removed.length}`);
    }
  }
  return actions;
}
