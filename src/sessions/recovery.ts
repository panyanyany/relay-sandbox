import { unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Docker from "dockerode";
import { readJson, writeExclusiveJson } from "../storage/files.js";
import { getTask, saveTask, taskPath } from "../tasks/store.js";
import { processIdentity } from "../tasks/lock.js";
import { resumeTask } from "../tasks/recovery.js";
import { readDevelopmentSession } from "../terminal/session.js";
import {
  readSessionOperation,
  sessionOperationPath,
  withSessionOperation,
} from "./operation.js";
import { ensureSessionReady } from "./readiness.js";
import {
  recordBackendFailure,
  readSessionState,
  updateSessionState,
} from "./state.js";
import {
  readStopIntent,
  stopIntentPath,
  recoveryIntentPath,
} from "./stop-intent.js";
import { sessionWorkerPaths } from "./worker-api.js";
import { appendSessionEvent } from "./event-store.js";
import type { DevelopmentSession } from "./schema.js";

const taskOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    identity: z.string().min(1),
    expiresAt: z.iso.datetime(),
  })
  .strict();
const ownerSchema = z
  .object({
    pid: z.number().int().positive(),
    identity: z.string().min(1),
    token: z.uuid(),
  })
  .strict();
interface RecoveryOptions {
  home: string;
  session: DevelopmentSession;
  docker: Docker;
  resumeTask?: typeof resumeTask;
  ensureReady?: typeof ensureSessionReady;
}
async function owner(path: string) {
  try {
    return ownerSchema.parse(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function requireDead(
  value: { pid: number; identity: string } | undefined,
) {
  if (value && (await processIdentity(value.pid)) === value.identity)
    throw new Error("旧会话进程仍存活，不能清理其锁或恢复");
}
// 只检查标签归属的全部写入者；Docker不可用、缺主容器或归属不明均拒绝恢复。
async function requireStopped(options: RecoveryOptions) {
  const task = await getTask(options.home, options.session.taskId!);
  if (
    task.terminalSessionId !== options.session.id ||
    task.projectId !== options.session.projectId ||
    task.projectRoot !== options.session.cwd ||
    !task.containerId
  )
    throw new Error("恢复任务归属不明");
  const owners = new Set([
    task.id,
    ...(task.environmentId ? [task.environmentId] : []),
  ]);
  const listed = await options.docker.listContainers({
    all: true,
    filters: { label: ["relay-sandbox.task"] },
  });
  for (const id of new Set([
    task.containerId,
    ...listed.map((item) => item.Id),
  ])) {
    const info = await options.docker.getContainer(id).inspect();
    const owned = owners.has(info.Config.Labels?.["relay-sandbox.task"] ?? "");
    if (id === task.containerId && !owned)
      throw new Error("主容器归属不明，不能恢复");
    if (owned && info.State.Running)
      throw new Error("旧会话容器仍有写入者，请先显式停止");
  }
  return task;
}
// 主动恢复只保留文件和原生会话ID，不恢复旧模型请求或重放prompt。
export async function recoverSession(options: RecoveryOptions) {
  const { home, session } = options;
  if (!session.taskId) throw new Error("会话没有可恢复的任务");
  const stored = await readDevelopmentSession(home, session.id, {
    cwd: session.cwd,
    projectId: session.projectId,
    agent: session.agent,
  });
  if (
    stored.taskId !== session.taskId ||
    stored.environmentId !== session.environmentId
  )
    throw new Error("恢复会话环境绑定不符");
  if (
    !stored.nativeSessionId ||
    stored.nativeSessionId !== session.nativeSessionId
  )
    throw new Error("缺失或不匹配的原生会话身份，不能将新建上下文当作恢复");
  const lock = recoveryIntentPath(home, session.id);
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("无法确定恢复进程身份");
  const recovery = { token: randomUUID(), pid: process.pid, identity };
  await writeExclusiveJson(lock, recovery);
  let task;
  try {
    const workerPath = sessionWorkerPaths(home, session.id).lock;
    const worker = await owner(workerPath),
      operation = await readSessionOperation(home, session.id),
      intent = await readStopIntent(home, session.id);
    const taskLock = join(taskPath(home, session.taskId), "operation.lock");
    let taskOwner;
    try {
      taskOwner = taskOwnerSchema.parse(await readJson(taskLock));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await requireDead(taskOwner);
    await requireDead(worker);
    await requireDead(operation);
    await requireDead(intent);
    await requireStopped(options);
    // 错误示范：只按锁文件年龄删除，会误删仍活跃或PID被复用的进程租约。
    for (const [path, captured] of [
      [workerPath, worker],
      [sessionOperationPath(home, session.id), operation],
      [stopIntentPath(home, session.id), intent],
    ] as const) {
      if (!captured) continue;
      const current = (await readJson(path)) as { token?: string };
      if (current.token !== captured.token)
        throw new Error("恢复期间锁归属变化");
      await requireDead(captured);
      await unlink(path);
    }
    if (taskOwner) {
      const current = taskOwnerSchema.parse(await readJson(taskLock));
      if (JSON.stringify(current) !== JSON.stringify(taskOwner))
        throw new Error("任务租约归属变化");
      await requireDead(taskOwner);
      await unlink(taskLock);
    }
    const stoppedTask = await getTask(home, session.taskId);
    if (!["interrupted", "stopped", "failed"].includes(stoppedTask.state)) {
      stoppedTask.state = "interrupted";
      stoppedTask.warnings.push(
        "已确认旧会话写入者停止，恢复前保留异常中断记录",
      );
      await saveTask(home, stoppedTask);
    }
    const socket = sessionWorkerPaths(home, session.id).socket;
    try {
      const info = await lstat(socket);
      if (!info.isSocket()) throw new Error("遗留后台入口不是socket");
      await unlink(socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    task = await withSessionOperation(
      home,
      session.id,
      "prepare",
      async (lease) => {
        const state = await readSessionState(home, session.id);
        // 已确认所有旧写入者停止后才解除busy，既有任务恢复负责网络和三方同步。
        if (state.phase !== "interrupted")
          await updateSessionState(home, session.id, lease, {
            phase: "interrupted",
          });
        const task = await (options.resumeTask ?? resumeTask)(
          home,
          session.taskId!,
        );
        return task;
      },
      { recoveryToken: recovery.token },
    );
  } finally {
    const current = await owner(lock);
    if (current?.token !== recovery.token)
      throw new Error("恢复协调锁归属不符");
    await unlink(lock);
  }
  // 错误示范：持恢复协调锁启动 worker 会被准入拒绝；容器运行也不能代替 Agent 就绪。
  try {
    await (options.ensureReady ?? ensureSessionReady)(home, stored);
    return await withSessionOperation(
      home,
      session.id,
      "prepare",
      async (lease) => {
        await updateSessionState(home, session.id, lease, {
          phase: "idle",
          invalidateEvidence: true,
        });
        const summary =
          "会话文件和原生上下文已恢复；异常中断的审计可能不完整，请显式审查。未重放任何模型输入";
        await appendSessionEvent(home, session.id, {
          type: "gap",
          payload: { reason: summary },
        });
        await appendSessionEvent(home, session.id, {
          type: "state",
          payload: { state: "idle", detail: summary },
        });
        return { session: stored, task, summary };
      },
    );
  } catch (error) {
    await recordBackendFailure(
      home,
      session.id,
      "Agent 恢复就绪失败；请检查保留的后台诊断",
    );
    throw error;
  }
}
