import { createInterface } from "node:readline";
import type { InteractiveExec } from "../../docker/interactive.js";
import type { SessionOperationLease } from "../../sessions/operation.js";
import type { SessionEventInput } from "../../sessions/events.js";
import { codexSessionAdapter } from "./codex.js";

import { createCodexRpc, type CodexRpcMessage as Rpc } from "./codex-rpc.js";

const reads = new Set([
  "account/read",
  "config/read",
  "configRequirements/read",
  "model/list",
  "collaborationMode/list",
  "hooks/list",
  "skills/list",
  "plugin/list",
  "thread/read",
  "thread/list",
  "thread/loaded/list",
  "thread/turns/list",
  "thread/items/list",
  "thread/goal/get",
  "thread/attachment/list",
  "thread/attachmentOwner/list",
  "account/rateLimits/read",
  "mcpServerStatus/list",
  "experimentalFeature/list",
  "permissionProfile/list",
  "fs/readFile",
  "fs/readDirectory",
  "fs/getMetadata",
  "fuzzyFileSearch",
]);
// 只接受app-server原生输入项；技能路径由能力适配器解析，不直接执行shell。
export type CodexTurnInput =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string };
export interface CodexGatewayInput {
  upstream: InteractiveExec;
  fail?(error: unknown): Promise<void>;
  nativeSessionId?: string;
  bindNativeSession(id: string): Promise<unknown>;
  emit(event: SessionEventInput): Promise<unknown>;
}
// 结构化入口共享真实 app-server 线程；执行租约由 worker 保存和释放。
export async function createCodexGateway(input: CodexGatewayInput) {
  let active:
    | {
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;
  let trackedThread = input.nativeSessionId;
  let turnId: string | undefined;
  let failed: Error | undefined;
  let closed = false;
  let expectedBackendStop = false;
  let serial = Promise.resolve();
  const send = (message: Rpc) =>
    input.upstream.stdin.write(JSON.stringify(message) + "\n");
  const rpc = createCodexRpc(send);
  const request = rpc.request;
  async function finish(error?: Error) {
    const operation = active;
    if (!operation) return;
    active = undefined;
    turnId = undefined;
    if (error) operation.reject(error);
    else operation.resolve();
  }
  function fatal(error: Error) {
    if (failed) return;
    failed = error;
    rpc.close(error);
    serial = serial
      .catch(() => {})
      .then(async () => {
        try {
          if (!closed && !expectedBackendStop) await input.fail?.(error);
        } finally {
          await finish(error);
        }
      });
    void serial.catch(() => {});
  }
  const lines = createInterface({ input: input.upstream.stdout });
  lines.on("line", (line) => {
    serial = serial.then(async () => {
      const message = JSON.parse(line) as Rpc;
      if (rpc.accept(message)) return;
      if (message.id !== undefined) {
        // 未启用的服务器审批不能由任意前端竞相批准；容器使用明确的开发策略。
        send({
          id: message.id,
          error: { code: -32001, message: "未支持的原生服务器请求" },
        });
        return;
      }
      if (
        message.params?.threadId !== undefined &&
        message.params.threadId !== trackedThread &&
        trackedThread
      )
        return;
      for (const event of codexSessionAdapter.events({
        method: message.method ?? "",
        params: message.params,
      }))
        await input.emit(event);
      if (
        message.method === "turn/started" &&
        message.params?.threadId === trackedThread
      ) {
        const startedId = (message.params?.turn as { id?: string } | undefined)
          ?.id;
        if (active && startedId) {
          turnId = startedId;
        }
      }
      if (
        message.method === "turn/completed" &&
        message.params?.threadId === trackedThread
      ) {
        const turn = message.params?.turn as
          | { status?: string; error?: { message?: string } }
          | undefined;
        if (
          !active ||
          !turnId ||
          (turn as { id?: string } | undefined)?.id !== turnId
        )
          return;
        await finish(
          turn?.status !== "completed"
            ? new Error(
                turn?.error?.message ??
                  `Codex 轮次未完成: ${turn?.status ?? "unknown"}`,
              )
            : undefined,
        );
      }
    });
    void serial.catch(fatal);
  });
  input.upstream.stderr.resume(); // 始终排空；原始诊断不广播给任意客户端。
  void input.upstream.completion.then(
    (code) => {
      if (!closed && !expectedBackendStop)
        fatal(new Error(`Codex app-server 退出: ${code}`));
    },
    (error) => {
      if (!closed && !expectedBackendStop)
        fatal(error instanceof Error ? error : new Error(String(error)));
    },
  );
  const handshake = async <T>(promise: Promise<T>): Promise<T> => {
    let timer!: NodeJS.Timeout;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex 初始化超时")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  await handshake(
    request("initialize", {
      clientInfo: { name: "relay-sandbox", version: "1" },
      capabilities: { experimentalApi: true },
    }),
  );
  send({ method: "initialized" });
  const thread = (await handshake(
    request(input.nativeSessionId ? "thread/resume" : "thread/start", {
      ...(input.nativeSessionId ? { threadId: input.nativeSessionId } : {}),
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }),
  )) as { thread: { id: string; turns?: unknown[] } };
  const nativeId = thread.thread?.id;
  if (
    !nativeId ||
    (input.nativeSessionId && input.nativeSessionId !== nativeId)
  )
    throw new Error("Codex 原生线程身份不一致");
  trackedThread = nativeId;
  await input.bindNativeSession(nativeId);
  async function execute(method: string, params: Record<string, unknown>) {
    if (active) throw new Error("会话 busy");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completion.catch(() => {});
    active = { resolve, reject };
    try {
      const result = await request(method, { ...params, threadId: nativeId });
      turnId = (result as { turn?: { id?: string } })?.turn?.id ?? turnId;
      return { result, completion };
    } catch (error) {
      await finish(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  // worker已保存并取得执行租约；类型化输入不会再次获取原生前端锁。
  async function submitInputs(
    inputs: CodexTurnInput[],
    _context: { lease: SessionOperationLease },
  ) {
    if (
      inputs.length === 0 ||
      inputs.some(
        (item) =>
          item.type === "skill" && (!item.name.trim() || !item.path.trim()),
      )
    )
      throw new Error("Codex原生技能名称和路径不能为空");
    const turn = await execute("turn/start", { input: inputs });
    await turn.completion;
  }
  return {
    nativeSessionId: nativeId,
    // U09只读技能发现复用真实RPC，禁止从这个接缝发起执行或跨线程读取。
    async read(method: string, params: Record<string, unknown> = {}) {
      if (!reads.has(method))
        throw new Error(`不是受支持的只读方法: ${method}`);
      if (params.threadId !== undefined && params.threadId !== nativeId)
        throw new Error("禁止访问其他原生线程");
      return request(method, params);
    },
    submitInputs,
    async submit(prompt: string, context: { lease: SessionOperationLease }) {
      await submitInputs([{ type: "text", text: prompt }], context);
    },
    async stop() {
      if (active) {
        if (!turnId) throw new Error("当前执行没有可中断的 turnId");
        await request("turn/interrupt", { threadId: nativeId, turnId });
      }
      expectedBackendStop = true;
    },
    async close() {
      closed = true;
      rpc.close(new Error("Codex 会话关闭"));
      await finish(new Error("Codex 会话关闭"));
      lines.close();
      input.upstream.stdin.end();
    },
  };
}
