import { setTimeout as delay } from "node:timers/promises";
import { developmentSessionSchema, type DevelopmentSession } from "./schema.js";
import {
  parseSessionInput,
  SESSION_HELP,
  type SessionInput,
} from "./commands.js";
import type { ExecutableSessionRequest } from "./requests.js";
import type { WorkerCommand } from "./worker-api.js";
import {
  jsonSessionInputSchema,
  jsonReplaySchema,
  type JsonSessionOutput,
} from "./json-protocol.js";
export interface JsonSessionOptions {
  input: AsyncIterable<string>;
  write(event: JsonSessionOutput): void | Promise<void>;
  activate?(
    request: ExecutableSessionRequest,
    onSaved: (session: DevelopmentSession) => Promise<void>,
  ): Promise<DevelopmentSession>;
  readOnly?(command: SessionInput["type"]): Promise<unknown>;
  ensureSession?(input: {
    sessionId?: string;
    onSession(session: DevelopmentSession): Promise<void>;
  }): Promise<DevelopmentSession>;
  dispatch(id: string): Promise<unknown>;
  request(id: string, command: WorkerCommand): Promise<Record<string, unknown>>;
  signal?: AbortSignal;
  after?: number;
  followUntilIdle?: boolean;
  pollMilliseconds?: number;
}
// JSONL 只是观察与输入通道；退出不发送 stop，也不终止后台开发轮次。
export async function runJsonSession(options: JsonSessionOptions) {
  const iterator = options.input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("缺少 JSON 输入");
  const parse = (line: string) => {
    if (Buffer.byteLength(line) > 262144)
      throw new Error("JSON 输入超过容量预算");
    return jsonSessionInputSchema.parse(JSON.parse(line));
  };
  const initial = parse(first.value);
  let identity: DevelopmentSession | undefined;
  let session: DevelopmentSession | undefined;
  let outputError: unknown;
  let phase = "input";
  // 输出断开只结束观察；已保存请求仍须完成一次派发。
  async function write(event: JsonSessionOutput) {
    if (outputError) return;
    try {
      await options.write(event);
    } catch (error) {
      outputError = error;
    }
  }
  async function announce(value: DevelopmentSession) {
    const session = developmentSessionSchema.parse(value);
    if (identity) {
      if (
        identity.id !== session.id ||
        identity.agent !== session.agent ||
        identity.cwd !== session.cwd ||
        identity.projectId !== session.projectId
      )
        throw new Error("初始化返回了不同会话编号");
      return;
    }
    if (initial.sessionId && initial.sessionId !== session.id)
      throw new Error("续接会话编号不一致");
    identity = session;
    await write({
      type: "relay.session",
      sessionId: session.id,
      version: 2,
      agent: session.agent,
    });
  }
  let cursor = initial.after ?? options.after ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("事件游标无效");
  let pending = false;
  async function replayEvents() {
    if (!session || outputError) return;
    phase = "observe";
    const data = jsonReplaySchema.parse(
      await options.request(session.id, { type: "events", after: cursor }),
    );
    if (data.cursor < cursor) throw new Error("会话事件游标倒退");
    if (data.gap)
      await write({
        type: "relay.gap",
        sessionId: session.id,
        ...data.gap,
      });
    for (const event of data.events) {
      if (event.sessionId !== session.id || event.cursor <= cursor)
        throw new Error("会话事件身份或游标错误");
      await write({ type: "relay.event", event });
      cursor = event.cursor;
    }
    cursor = data.cursor;
    if (pending) {
      const status = await options.request(session.id, { type: "status" });
      if (status.failure) throw new Error(String(status.failure));
      const state = status.state as { phase?: string } | undefined;
      if (state?.phase === "idle" || state?.phase === "interrupted")
        pending = false;
    }
  }
  async function submit(payload: ReturnType<typeof parse>) {
    if (payload.sessionId && session && payload.sessionId !== session.id)
      throw new Error("同一输入通道不能切换会话");
    const command =
      "prompt" in payload
        ? parseSessionInput(payload.prompt)
        : "request" in payload
          ? payload.request
          : { type: payload.command };
    if (command.type === "exit") return false;
    if (command.type !== "message" && command.type !== "skill") {
      phase = "query";
      let result: unknown;
      // 已有正式身份可续接只读观察；全新查询不得调用创建入口。
      if (!session && payload.sessionId) {
        if (!options.ensureSession) throw new Error("未配置会话恢复入口");
        session = await options.ensureSession({
          sessionId: payload.sessionId,
          onSession: announce,
        });
        await announce(session);
        await options.dispatch(session.id);
      }
      if (command.type === "help") result = { help: SESSION_HELP };
      else if (session)
        result = await options.request(session.id, { type: command.type });
      else if (command.type === "stop" || command.type === "review")
        throw new Error("尚无正式会话");
      else
        result = options.readOnly
          ? await options.readOnly(command.type)
          : { phase: "unstarted", supported: false };
      await write({
        type: "relay.readonly",
        command: command.type,
        result,
        ...(session ? { sessionId: session.id } : {}),
      });
      // stop成功后后台会关闭；结束观察，不把后续socket消失报为停止失败。
      return command.type !== "stop";
    }
    if (!session) {
      phase = "save";
      if (options.activate && !payload.sessionId)
        session = await options.activate(command, announce);
      else {
        if (!options.ensureSession) throw new Error("未配置会话恢复入口");
        session = await options.ensureSession({
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          onSession: announce,
        });
      }
      await announce(session);
      phase = "prepare";
      await options.dispatch(session.id);
    }
    phase = "execute";
    const result = await options.request(
      session.id,
      options.activate || "request" in payload
        ? { type: "execute", request: command }
        : command.type === "message"
          ? { type: "submit", prompt: command.prompt }
          : { type: "execute", request: command },
    );
    if (result.accepted !== true) throw new Error("会话后台未确认接受输入");
    pending = true;
    await write({ type: "relay.accepted", sessionId: session.id });
    return true;
  }
  const report = async (error: unknown) =>
    write({
      type: "relay.error",
      message: error instanceof Error ? error.message : String(error),
      phase,
    });
  async function replay() {
    try {
      await replayEvents();
    } catch (error) {
      if (options.signal?.aborted) return;
      await report(error);
      throw error;
    }
  }
  try {
    if (!(await submit(initial))) {
      if (outputError) throw outputError;
      return { sessionId: session?.id, cursor };
    }
  } catch (error) {
    if (options.signal?.aborted) return { sessionId: session?.id, cursor };
    await report(error);
    throw error;
  }
  if (outputError) throw outputError;
  await replay();
  let next = iterator.next();
  let eof = false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ kind: "abort" }>((resolve) => {
    if (options.signal?.aborted) resolve({ kind: "abort" });
    else
      options.signal?.addEventListener(
        "abort",
        (onAbort = () => resolve({ kind: "abort" })),
        { once: true },
      );
  });
  try {
    while (!options.signal?.aborted && !outputError) {
      if (eof && (!pending || options.followUntilIdle === false)) break;
      const controller = new AbortController();
      const tick = delay(options.pollMilliseconds ?? 100, undefined, {
        signal: controller.signal,
      }).then(
        () => ({ kind: "tick" as const }),
        () => ({ kind: "abort" as const }),
      );
      const event = await Promise.race([
        aborted,
        tick,
        ...(!eof
          ? [next.then((value) => ({ kind: "line" as const, value }))]
          : []),
      ]);
      controller.abort();
      if (event.kind === "abort") break;
      if (event.kind === "line") {
        if (event.value.done) eof = true;
        else {
          try {
            phase = "input";
            if (!(await submit(parse(event.value.value)))) break;
          } catch (error) {
            if (options.signal?.aborted) break;
            await report(error);
          }
          next = iterator.next();
        }
      }
      if (!eof || (pending && options.followUntilIdle !== false))
        await replay();
    }
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
  // 错误示范：iterator.return()/关闭输入时顺带调用 worker.stop，会把网页断线变成取消。
  if (outputError) throw outputError;
  return { sessionId: session?.id, cursor };
}
