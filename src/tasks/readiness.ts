import { access } from "node:fs/promises";
import { join } from "node:path";
import { taskPath } from "./store.js";
import type { Task } from "./types.js";

// 旧成功检查点尚未记录宿主导入归属，须先恢复迁移，不能沿用旧候选。
export function legacyWorkspaceCheckpoint(task: Task): boolean {
  return (
    !["cleaned", "completed"].includes(task.state) &&
    task.workspaceSync?.status === "applied" &&
    task.workspaceSync.version !== 2
  );
}

// 错误示范：只在 run 阻断半写入工作区，仍可经重收集生成新的可交付结果。
export function workspaceUnavailable(task: Task): boolean {
  return (
    legacyWorkspaceCheckpoint(task) ||
    !!task.recoveryPending ||
    !!task.workspaceOperation ||
    task.workspaceSync?.status === "applying"
  );
}
export function requireWorkspaceUsable(task: Task): void {
  if (legacyWorkspaceCheckpoint(task))
    throw new Error(
      "旧恢复检查点须先取消任务再恢复，以补建有效交付基线；暂不能运行、收集或交付",
    );
  if (workspaceUnavailable(task))
    throw new Error(
      "工作区正在恢复或同步未完成，不能运行、收集或交付；请等待恢复完成，失败后先取回现场",
    );
}

// 旧任务没有显式标记时兼容已存在的容器；新任务必须完成全部准备步骤。
export function environmentReady(task: Task): boolean {
  return (
    !!task.containerId &&
    task.environmentReady !== false &&
    !workspaceUnavailable(task)
  );
}
// 错误示范：仅检查preparing状态或仅有容器，就可能在上传或审计安装期间提前运行。
export function requireEnvironmentReady(task: Task): void {
  if (!environmentReady(task))
    throw new Error(
      "任务环境尚未准备就绪，请用wait_task或get_task等待environmentReady=true后再运行",
    );
}

// 就绪状态写盘不等于租约已交接；发布快照时同时核对准备锁。
export async function preparationHandoffPending(home: string, task: Task) {
  if (task.state !== "prepared") return false;
  try {
    await access(join(taskPath(home, task.id), "operation.lock"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function taskLockBusy(error: unknown, home: string, id: string) {
  return (
    (error as NodeJS.ErrnoException).code === "EEXIST" &&
    (error as NodeJS.ErrnoException).path ===
      join(taskPath(home, id), "operation.lock")
  );
}

// 旧版没有阶段标记，仅兼容明确的归档类型错误；不把任意执行失败当成可收集。
export function canRecollect(task: Task) {
  return (
    task.state === "failed" &&
    !workspaceUnavailable(task) &&
    (task.failureStage === "collection" ||
      (!task.failureStage &&
        /^(?:Error: )?不支持的归档类型:/.test(task.error ?? "")))
  );
}
