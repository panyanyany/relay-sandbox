import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { download } from "../docker/archive.js";
import { dockerClient } from "../docker/client.js";
import {
  replaceGitDirectory,
  replaceRuntimeWorkspace,
  replaceHostBaseline,
  resetRuntimeGit,
} from "../workspace/sync-operations.js";
import { deliveryBaseline } from "./delivery-baseline.js";
import { mergeCandidate } from "../delivery/merge.js";
import {
  environmentPath,
  readEnvironment,
  saveEnvironment,
  withEnvironmentLock,
} from "../environments/store.js";
import { writeJson } from "../storage/files.js";
import { projectIdentity, taskProjectMode } from "../workspace/access.js";
import { changes } from "../workspace/diff.js";
import { scan, manifestDigest } from "../workspace/manifest.js";
import { snapshot } from "../workspace/snapshot.js";
import { discardCandidate, invalidateResult } from "./artifact-state.js";
import { saveTask, taskPath } from "./store.js";
import type { Task } from "./types.js";

// 错误示范：复用任务初始交付基线作为每次恢复的同步基线，会误判宿主后续撤销。
export async function synchronizeResumedWorkspace(home: string, task: Task) {
  if (task.workspaceSync?.status === "applying")
    throw new Error(
      "上次恢复同步未完成；请先取回 resume-sync 中的现场，再清理任务并显式重置环境",
    );
  if ((await taskProjectMode(home, task)) === "direct") {
    // 直接挂载没有导入新副本；保留已收集清单供后续一致性校验，只废止候选与审核。
    await discardCandidate(home, task);
    return;
  }
  invalidateResult(task);
  await discardCandidate(home, task);
  if (
    task.projectIdentity &&
    task.projectIdentity !== (await projectIdentity(task.projectRoot))
  )
    throw new Error("原项目目录已被替换，不能同步到旧任务");
  const root = taskPath(home, task.id);
  let base = task.workspaceSync
    ? join(root, "resume-sync", task.workspaceSync.id, "host")
    : join(root, "host-baseline");
  if (!task.workspaceSync) {
    try {
      await stat(base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 一次性旧任务的初始副本就是宿主基线；持久任务不可退回工作区基线。
      if (task.environmentId)
        throw new Error("缺少持久任务宿主基线，不能安全恢复同步", {
          cause: error,
        });
      base = join(root, "baseline");
    }
  }
  const id = randomUUID(),
    stage = join(root, "resume-sync", id);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const host = join(stage, "host"),
    current = join(stage, "before"),
    candidate = join(stage, "candidate");
  const previous = task.workspaceSync;
  const hostManifest = await snapshot(
    task.projectRoot,
    host,
    task.config.project.exclude,
  );
  const hostChanges = changes(await scan(base), hostManifest);
  const changed = hostChanges.length > 0;
  let effectiveBase = previous?.deliveryBase;
  let conflicts: string[] = [];
  let oldDelivery = deliveryBaseline(home, task);
  let migrated = false;
  // 兼容上一版成功检查点：补入当时已导入的宿主增量，不沿用有缺陷的交付基线。
  if (previous && !previous.deliveryBase) {
    let initialHost = join(root, "host-baseline");
    try {
      await stat(initialHost);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        task.environmentId
      )
        throw error;
      initialHost = join(root, "baseline");
    }
    if (
      manifestDigest(await scan(initialHost)) !==
      manifestDigest(await scan(base))
    ) {
      const legacy = join(stage, "legacy-delivery");
      await snapshot(oldDelivery, legacy, []);
      conflicts = (await mergeCandidate(initialHost, base, oldDelivery, legacy))
        .conflicts;
      oldDelivery = legacy;
      migrated = true;
    }
  }
  if (changed) {
    await download(
      dockerClient(),
      task.containerId!,
      current,
      task.config.resources,
    );
    await snapshot(current, candidate, []);
    const merged = await mergeCandidate(base, host, current, candidate);
    conflicts.push(...merged.conflicts);
    await replaceGitDirectory(host, candidate);
  }
  if (changed || migrated) {
    // 错误示范：保留最初交付基线，会把导入的宿主修改误算为 Agent 成果。
    const nextDelivery = join(stage, "delivery-baseline");
    await snapshot(oldDelivery, nextDelivery, []);
    const rebased = await mergeCandidate(base, host, oldDelivery, nextDelivery);
    conflicts = [...new Set([...conflicts, ...rebased.conflicts])];
    effectiveBase = id;
  }
  await writeJson(join(stage, "report.json"), {
    id,
    createdAt: new Date().toISOString(),
    changed,
    conflicts,
    changes: hostChanges.map(({ path, kind }) => ({ path, kind })),
  });
  if (conflicts.length)
    throw new Error(
      `恢复同步冲突，容器工作区未改动；现场：${stage}；冲突：${conflicts.join(", ")}`,
    );
  if (
    manifestDigest(
      await scan(task.projectRoot, task.config.project.exclude),
    ) !== manifestDigest(hostManifest)
  )
    throw new Error(
      "恢复同步期间宿主项目发生变化，请重新恢复；容器工作区未改动",
    );
  const apply = async () => {
    const environment = task.environmentId
      ? await readEnvironment(home, task.projectId)
      : undefined;
    if (
      task.environmentId &&
      (!environment ||
        environment.id !== task.environmentId ||
        environment.activeTaskId !== task.id ||
        environment.needsReset)
    )
      throw new Error("项目环境归属或同步状态不允许恢复");
    // 先持久化未完成标记；写入中断时禁止把半成品交给 Agent。
    task.workspaceSync = {
      id,
      status: "applying",
      version: 2,
      ...(effectiveBase ? { deliveryBase: effectiveBase } : {}),
    };
    await saveTask(home, task);
    if (environment) {
      environment.needsReset = true;
      await saveEnvironment(home, environment);
    }
    if (changed)
      await replaceRuntimeWorkspace(
        dockerClient(),
        task.containerId!,
        candidate,
      );
    else await resetRuntimeGit(dockerClient(), task.containerId!, host, stage);
    if (environment) {
      await replaceHostBaseline(
        host,
        join(environmentPath(home, task.projectId), "host-baseline"),
      );
      environment.needsReset = false;
      await saveEnvironment(home, environment);
    }
    if (changed || migrated)
      await writeJson(
        join(root, "delivery-baseline.json"),
        await scan(join(stage, "delivery-baseline")),
      );
    task.workspaceSync = {
      id,
      status: "applied",
      version: 2,
      ...(effectiveBase ? { deliveryBase: effectiveBase } : {}),
    };
    task.warnings.push(
      `恢复前已三方同步宿主项目；旧工作区、宿主快照及同步报告：${stage}。旧交付检查已失效。`,
    );
    await saveTask(home, task);
  };
  if (task.environmentId)
    await withEnvironmentLock(home, task.projectId, apply);
  else await apply();
}
