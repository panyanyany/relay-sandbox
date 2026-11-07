import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readStopIntent, stopIntentPath } from "./stop-intent.js";
export { readStopIntent, stopIntentPath } from "./stop-intent.js";
import { readDevelopmentSession } from "../terminal/session.js";
import { getTask } from "../tasks/store.js";
import { stopTask } from "../tasks/cleanup.js";
import { processIdentity } from "../tasks/lock.js";
import { writeExclusiveJson, writeJson } from "../storage/files.js";
import { formatError } from "../audit/redaction.js";
import { withSessionOperation, readSessionOperation } from "./operation.js";
import { updateSessionState } from "./state.js";
import { appendSessionEvent } from "./event-store.js";
import type { DevelopmentSession } from "./schema.js";

interface StopOptions {
  home: string;
  session: DevelopmentSession;
  driver: { stop(): Promise<void> };
  audit: { finish(): Promise<unknown> };
  failedBackend?: { afterWritersStopped(): Promise<void> };
  timeoutMs?: number;
  secrets?: string[];
  stopTask?: typeof stopTask;
}
// 停止意图先阻止新输入，再让原开发操作自行归还租约，绝不抢占活锁。
export async function stopSession(options: StopOptions) {
  const { home, session } = options;
  if (!session.taskId) throw new Error("会话没有运行任务");
  const stored = await readDevelopmentSession(home, session.id, {
    cwd: session.cwd,
    projectId: session.projectId,
    agent: session.agent,
  });
  const task = await getTask(home, session.taskId);
  if (
    stored.taskId !== session.taskId ||
    stored.environmentId !== session.environmentId ||
    task.terminalSessionId !== session.id ||
    task.projectId !== session.projectId ||
    task.projectRoot !== session.cwd
  )
    throw new Error("停止任务与会话归属不符");
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("无法确认停止请求进程身份");
  const intent = { token: randomUUID(), pid: process.pid, identity };
  await writeExclusiveJson(stopIntentPath(home, session.id), intent);
  let expectedBusy = false;
  try {
    const current = await readSessionOperation(home, session.id);
    if (current && current.kind !== "development") {
      expectedBusy = true;
      throw new Error("其他操作正在进行，不能中断审查或恢复");
    }
    let confirmedTask: Awaited<ReturnType<typeof stopTask>> | undefined;
    if (options.failedBackend) {
      // 错误示范：先释放死后端租约会让尚存的服务写入者与恢复并发。
      confirmedTask = await (options.stopTask ?? stopTask)(
        home,
        session.taskId,
      );
      if (!["stopped", "completed"].includes(confirmedTask.state))
        throw new Error("整个任务尚未确认停止");
      await options.failedBackend.afterWritersStopped();
    } else await options.driver.stop();
    const deadline = Date.now() + (options.timeoutMs ?? 30000);
    while (await readSessionOperation(home, session.id)) {
      if (Date.now() >= deadline)
        throw new Error("停止超时，开发操作尚未归还租约；保留现场等待恢复");
      await delay(25);
    }
    const result = await withSessionOperation(
      home,
      session.id,
      "stop",
      async (lease) => {
        const task =
          confirmedTask ??
          (await (options.stopTask ?? stopTask)(home, session.taskId!));
        if (!["stopped", "completed"].includes(task.state))
          throw new Error("整个任务尚未确认停止");
        await updateSessionState(home, session.id, lease, {
          phase: "interrupted",
        });
        await options.audit.finish();
        const summary =
          "会话已停止，保留代码、环境和可用审计证据；尚未独立审查，不会自动重放输入";
        await appendSessionEvent(home, session.id, {
          type: "state",
          payload: { state: "stopped", detail: summary },
        });
        return { task, summary };
      },
    );
    const stored = await readStopIntent(home, session.id);
    if (stored?.token !== intent.token) throw new Error("停止意图归属已变化");
    await unlink(stopIntentPath(home, session.id));
    return result;
  } catch (error) {
    if (expectedBusy) {
      // 尚未触碰driver或写入者；预期忙碌拒绝应撤销本次停止意图。
      const stored = await readStopIntent(home, session.id);
      if (stored?.token !== intent.token) throw new Error("停止意图归属已变化");
      await unlink(stopIntentPath(home, session.id));
      throw error;
    }
    // 错误示范：失败时删除intent会让不确定的旧进程再次接受输入。
    const diagnostic = formatError(error, options.secrets);
    await writeJson(join(home, "sessions", session.id, "stop-error.json"), {
      at: new Date().toISOString(),
      error: diagnostic,
    });
    throw new Error(diagnostic);
  }
}
