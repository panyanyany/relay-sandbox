import { dispatchSessionWorker } from "./dispatch.js";
import { readDevelopmentSession } from "../terminal/session.js";
import type { DevelopmentSession } from "./schema.js";

// 派发器仅在真实驱动初始化后读取到本次子进程的 status 才返回，不提交任何模型输入。
export async function ensureSessionReady(
  home: string,
  session: DevelopmentSession,
  dispatch: typeof dispatchSessionWorker = dispatchSessionWorker,
) {
  if (!session.nativeSessionId) throw new Error("恢复缺失原生会话身份");
  const status = await dispatch(home, session.id);
  // 单轮请求错误保留供观察；只有后端故障阻止重新接入。
  if (status.backendFailure) throw new Error(String(status.backendFailure));
  if (!Number.isInteger(status.workerPid) || Number(status.workerPid) <= 0)
    throw new Error("后台未返回真实就绪进程身份");
  const stored = await readDevelopmentSession(home, session.id, {
    cwd: session.cwd,
    projectId: session.projectId,
    agent: session.agent,
  });
  if (
    stored.nativeSessionId !== session.nativeSessionId ||
    stored.taskId !== session.taskId ||
    stored.environmentId !== session.environmentId
  )
    throw new Error("恢复期间原生会话或环境身份发生变化");
  return status;
}
