import { createServer } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFinalizer } from "../storage/finalize.js";
import { processIdentity } from "../tasks/lock.js";
import { readJson, writeExclusiveJson, writeJson } from "../storage/files.js";
import { formatError, redact } from "../audit/redaction.js";
import {
  acquireSessionOperation,
  SessionBusyError,
  releaseSessionOperation,
  type SessionOperationLease,
} from "./operation.js";
import { recordBackendFailure, readSessionState } from "./state.js";
import { appendSessionEvent, replaySessionEvents } from "./event-store.js";
import type { SessionEventInput } from "./events.js";
import { assertRecoveryAdmission } from "./stop-intent.js";
import { workerCommandSchema, sessionWorkerPaths } from "./worker-api.js";
import type { ExecutableSessionRequest } from "./requests.js";
import {
  nativeSkillListSchema,
  sessionCapabilitiesSchema,
  type NativeSkill,
  type SessionCapabilities,
} from "./capabilities.js";
import { WORKER_COMMAND_BYTE_LIMIT } from "./worker-api.js";
export interface NativeSessionDriver {
  submit(
    prompt: string,
    context: {
      emit: (event: SessionEventInput) => Promise<unknown>;
      lease: SessionOperationLease;
    },
  ): Promise<void>;
  stop?(): Promise<void>;
  close?(): Promise<void>;
}
// 公共后台仅暴露结构化请求，不接入厂商原生界面通道。
export interface WorkerSessionDriver extends NativeSessionDriver {
  // 统一输入能力由运行期装配；旧 submit 仅保留兼容调用。
  execute?(
    request: ExecutableSessionRequest,
    context: Parameters<NativeSessionDriver["submit"]>[1],
  ): Promise<void>;
  capabilities?(): Promise<SessionCapabilities>;
  listSkills?(): Promise<NativeSkill[]>;
  review?(evidenceId?: string): Promise<{ record: unknown; summary: string }>;
}
export interface NativeWorkerControls {
  fail(error: unknown): Promise<void>;
  settleFailedOperation(): Promise<void>;
  emit(event: SessionEventInput): Promise<unknown>;
  acquireNativeOperation(): Promise<SessionOperationLease>;
  completeNativeOperation(
    lease: SessionOperationLease,
    error?: unknown,
  ): Promise<void>;
}
// 工厂只有取得完整后台归属后才运行；错误示范：抢锁前先启动第二个 app-server。
export async function startSessionWorker(
  input: {
    home: string;
    id: string;
    secrets?: string[];
  } & (
    | { driver: WorkerSessionDriver; driverFactory?: never }
    | {
        driver?: never;
        driverFactory: (
          controls: NativeWorkerControls,
        ) => Promise<WorkerSessionDriver>;
      }
  ),
) {
  const { home, id } = input;
  let driver!: WorkerSessionDriver;
  const paths = sessionWorkerPaths(home, id);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("无法确定后台进程身份");
  await assertRecoveryAdmission(home, id);
  const owner = { pid: process.pid, identity, token: randomUUID() };
  try {
    await writeExclusiveJson(paths.lock, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("会话后台已存在，需要检查其状态");
    throw error;
  }
  let active: SessionOperationLease | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let turnFailure: string | undefined;
  let failedWritersStopped = false;
  let resolveCompletion!: () => void,
    rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {});
  let closing: Promise<void> | undefined;
  // 所有驱动共用落盘边界；逐个字符串处理，避免凭据中的引号破坏 JSON。
  const emit = (event: SessionEventInput) =>
    appendSessionEvent(home, id, {
      ...event,
      payload: Object.fromEntries(
        Object.entries(event.payload).map(([key, value]) => [
          key,
          typeof value === "string" ? redact(value, input.secrets) : value,
        ]),
      ),
    } as SessionEventInput);
  async function acquireNativeOperation() {
    if (closed) throw new Error("会话后台已关闭");
    if (fatalError) throw new Error(fatalError);
    const lease = await acquireSessionOperation(home, id, "development");
    active = lease;
    turnFailure = undefined;
    try {
      await emit({ type: "state", payload: { state: "busy" } });
      return lease;
    } catch (error) {
      await releaseSessionOperation(home, id, lease);
      active = undefined;
      throw error;
    }
  }
  async function completeNativeOperation(
    lease: SessionOperationLease,
    error?: unknown,
  ) {
    if (failedWritersStopped && !active) return;
    if (active?.token !== lease.token) throw new Error("后台操作租约不匹配");
    // 完成失败先进入状态快照，不能只写事件却让 JSON 前端以零退出。
    turnFailure =
      error === undefined ? undefined : formatError(error, input.secrets);
    await releaseSessionOperation(home, id, lease);
    active = undefined;
    await emit({
      type: "state",
      payload:
        error === undefined && !fatalError
          ? { state: "idle" }
          : {
              state: "failed",
              detail: fatalError ?? formatError(error, input.secrets),
            },
    });
  }
  let failurePending: Promise<void> | undefined;
  // 错误示范：只完成 active 会使空闲后端退出继续显示 idle。
  function fail(error: unknown) {
    fatalError ??= formatError(error, input.secrets);
    return (failurePending ??= (async () => {
      const current = (await readJson(paths.lock)) as typeof owner;
      if (current.token !== owner.token)
        throw new Error("后台归属已改变，拒绝记录其他后台故障");
      await recordBackendFailure(home, id, fatalError!);
      await writeJson(paths.diagnostic, {
        at: new Date().toISOString(),
        error: fatalError,
      });
      await emit({
        type: "gap",
        payload: { reason: `开发后端异常终止，审计可能不完整：${fatalError}` },
      });
      await emit({
        type: "state",
        payload: { state: "failed", detail: fatalError! },
      });
    })());
  }
  async function settleFailedOperation() {
    if (!fatalError) throw new Error("只有已确认故障后端可结束遗留开发操作");
    // runtime 已由 stopTask 确认全部归属写入者停止，仅归还自己的开发租约。
    if (active) await completeNativeOperation(active, new Error(fatalError));
    failedWritersStopped = true;
  }
  const server = createServer((socket) => {
    socket.setEncoding("utf8"); // 保留跨数据块的中文字符，避免替换字符改变长度。
    let data = "";
    let handled = false,
      stopRequested = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {}); // 已断开的观察客户端不改变后台执行状态。
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", (chunk) => {
      if (handled) return;
      data += chunk.toString();
      const respond = (value: unknown) => {
        if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n");
      };
      if (Buffer.byteLength(data) > WORKER_COMMAND_BYTE_LIMIT) {
        handled = true;
        respond({ ok: false, error: "后台命令超过容量预算" });
        return;
      }
      const end = data.indexOf("\n");
      if (end < 0) return;
      handled = true;
      clearTimeout(timer);
      void (async () => {
        const command = workerCommandSchema.parse(
          JSON.parse(data.slice(0, end)),
        );
        if (command.type === "status")
          return {
            state: await readSessionState(home, id),
            workerPid: process.pid,
            ...(fatalError ? { backendFailure: fatalError } : {}),
            ...(turnFailure ? { lastTurnFailure: turnFailure } : {}),
            ...((fatalError ?? turnFailure)
              ? { failure: fatalError ?? turnFailure }
              : {}),
          };
        if (command.type === "events")
          return { ...(await replaySessionEvents(home, id, command.after)) };
        if (command.type === "capabilities") {
          if (!driver.capabilities) throw new Error("当前驱动未提供能力发现");
          return sessionCapabilitiesSchema.parse(await driver.capabilities());
        }
        if (command.type === "skills") {
          if (!driver.capabilities || !driver.listSkills)
            throw new Error("当前驱动未提供技能发现");
          const support = sessionCapabilitiesSchema.parse(
            await driver.capabilities(),
          ).skills.list;
          if (support.status === "unsupported") throw new Error(support.reason);
          return {
            skills: nativeSkillListSchema.parse(await driver.listSkills()),
          };
        }
        if (command.type === "native") {
          // 保留旧命令识别以明确报错，不能按驱动对象的额外字段重新开放旁路。
          throw new Error("原生终端不支持，请使用统一逐行输入或网页会话");
        }
        if (command.type === "review") {
          if (!driver.review) throw new Error("当前驱动未提供独立审查能力");
          return driver.review(command.evidenceId);
        }
        if (command.type === "stop") {
          if (!driver.stop) throw new Error("当前驱动尚未提供停止能力");
          await driver.stop();
          closed = true;
          stopRequested = true;
          return { stopped: true };
        }
        // 能力发现可能很慢；先拒绝已忙请求，最终原子租约仍处理并发竞态。
        if (closed) throw new Error("会话后台已关闭");
        if (fatalError) throw new Error(fatalError);
        if (active) throw new SessionBusyError();
        const request =
          command.type === "submit"
            ? { type: "message" as const, prompt: command.prompt }
            : command.request;
        if (request.type === "skill") {
          if (!driver.execute || !driver.capabilities)
            throw new Error("当前驱动未提供技能调用");
          const support = sessionCapabilitiesSchema.parse(
            await driver.capabilities(),
          ).skills.invoke;
          if (support.status === "unsupported") throw new Error(support.reason);
          if (!driver.listSkills) throw new Error("当前驱动未提供技能发现");
          const skills = nativeSkillListSchema.parse(await driver.listSkills());
          if (!skills.some((skill) => skill.name === request.name))
            throw new Error(`未知技能：${request.name}`);
        }
        const lease = await acquireNativeOperation();
        const requestId = randomUUID();
        try {
          // 每次请求先原子保存再调用Agent；accepted记录不代表可自动重放。
          const directory = join(paths.directory, "requests");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeExclusiveJson(join(directory, `${requestId}.json`), {
            version: 1,
            requestId,
            sessionId: id,
            status: "accepted",
            acceptedAt: new Date().toISOString(),
            request,
          });
        } catch (error) {
          await completeNativeOperation(lease, error);
          throw error;
        }
        // 错误示范：await submit 后才应答会把长轮次绑定到前端请求超时。
        running = Promise.resolve()
          .then(() =>
            driver.execute
              ? driver.execute(request, { emit, lease })
              : driver.submit(
                  (request as { type: "message"; prompt: string }).prompt,
                  { emit, lease },
                ),
          )
          .then(
            () => completeNativeOperation(lease),
            (error) => completeNativeOperation(lease, error),
          );
        // 完成事件或状态写入错误仍暴露为后台诊断，不伪装轮次成功。
        running.catch(async (error) => {
          fatalError = formatError(error, input.secrets);
          try {
            await writeJson(paths.diagnostic, {
              at: new Date().toISOString(),
              error: fatalError,
            });
          } catch (persist) {
            fatalError = formatError(
              new AggregateError([error, persist], "后台错误无法落盘"),
              input.secrets,
            );
          }
        });
        return { accepted: true, requestId };
      })().then(
        (result) => {
          respond({ ok: true, result });
          // 先回执再收尾；客户端离开仍不走此显式停止路径。
          if (stopRequested) void close().catch(() => {});
        },
        (error) =>
          respond({ ok: false, error: formatError(error, input.secrets) }),
      );
    });
  });
  let fatalError: string | undefined;
  try {
    await assertRecoveryAdmission(home, id);
    driver = input.driverFactory
      ? await input.driverFactory({
          emit,
          fail,
          settleFailedOperation,
          acquireNativeOperation,
          completeNativeOperation,
        })
      : input.driver;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
  } catch (error) {
    closed = true;
    // 初始化失败也写现场，三项清理独立执行，不能因日志失败留下幽灵后台锁。
    const cleanup = await Promise.allSettled([
      writeJson(paths.diagnostic, {
        at: new Date().toISOString(),
        error: formatError(error, input.secrets),
      }),
      server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close((failure) => (failure ? reject(failure) : resolve())),
          )
        : Promise.resolve(),
      driver?.close?.(),
    ]);
    // 原生进程确认关闭后才释放归属，避免清理期间第二个后台抢先启动。
    if (cleanup.slice(1).every((result) => result.status === "fulfilled")) {
      cleanup.push(...(await Promise.allSettled([unlink(paths.lock)])));
    }
    const failures = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError([error, ...failures], "后台初始化及清理失败", {
        cause: error,
      });
    throw error;
  }
  function close() {
    closing ??= (async () => {
      closed = true;
      await withFinalizer(
        async () => {
          if (!failedWritersStopped) await running;
          await driver.close?.();
        },
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const current = (await readJson(paths.lock)) as typeof owner;
      if (current.token !== owner.token)
        throw new Error("后台归属已改变，拒绝清理");
      await unlink(paths.lock);
      if (fatalError) throw new Error(fatalError);
    })().then(resolveCompletion, async (error) => {
      try {
        await writeJson(paths.diagnostic, {
          at: new Date().toISOString(),
          error: formatError(error, input.secrets),
        });
      } catch (persist) {
        error = new AggregateError(
          [error, persist],
          "后台收尾失败且无法记录诊断",
          { cause: error },
        );
      }
      rejectCompletion(error);
      throw error;
    });
    return closing;
  }
  return {
    socketPath: paths.socket,
    acquireNativeOperation,
    completeNativeOperation,
    fail,
    completion,
    close,
  };
}
