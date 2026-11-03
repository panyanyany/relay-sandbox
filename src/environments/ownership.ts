import type { Task } from "../tasks/types.js";
import {
  readEnvironment,
  saveEnvironment,
  withEnvironmentLock,
} from "./store.js";

// 错误示范：仅凭旧任务containerId操作容器，会停止或删除下一任务正在使用的环境。
export async function ownsRuntime(home: string, task: Task): Promise<boolean> {
  if (!task.environmentId) return true;
  const environment = await readEnvironment(home, task.projectId);
  return (
    environment?.id === task.environmentId &&
    environment.activeTaskId === task.id
  );
}
export async function requireRuntimeOwner(home: string, task: Task) {
  if (!(await ownsRuntime(home, task)))
    throw new Error(
      "任务已释放项目环境，不能操作当前运行时；请创建新任务或显式恢复",
    );
}
// 恢复只重新取得同一环境，其他任务已借用或环境已重置时明确拒绝。
export async function claimEnvironment(home: string, task: Task) {
  if (!task.environmentId) return;
  await withEnvironmentLock(home, task.projectId, async () => {
    const environment = await readEnvironment(home, task.projectId);
    if (
      !environment ||
      environment.needsReset ||
      environment.id !== task.environmentId ||
      (environment.activeTaskId && environment.activeTaskId !== task.id) ||
      (!environment.activeTaskId &&
        environment.lastTaskId &&
        environment.lastTaskId !== task.id)
    )
      throw new Error("项目环境已由其他任务使用或已重置，不能恢复旧任务");
    environment.activeTaskId = task.id;
    delete environment.idleSince;
    await saveEnvironment(home, environment);
  });
}
// 调用方确认整个任务停止后释放；失败时不伪造空闲状态。
export async function releaseEnvironment(home: string, task: Task) {
  if (!task.environmentId) return;
  await withEnvironmentLock(home, task.projectId, async () => {
    const environment = await readEnvironment(home, task.projectId);
    if (
      !environment ||
      environment.id !== task.environmentId ||
      environment.activeTaskId !== task.id
    )
      return;
    delete environment.activeTaskId;
    environment.lastTaskId = task.id;
    environment.idleSince = new Date().toISOString();
    await saveEnvironment(home, environment);
  });
}
