import { createConnection } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { executableSessionRequestSchema } from "./requests.js";
export const WORKER_COMMAND_BYTE_LIMIT = 262144;
export const workerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }).strict(),
  z.object({ type: z.literal("capabilities") }).strict(),
  z.object({ type: z.literal("skills") }).strict(),
  z
    .object({
      type: z.literal("execute"),
      request: executableSessionRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("events"),
      after: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({ type: z.literal("submit"), prompt: z.string().min(1).max(65536) })
    .strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("native") }).strict(),
  z
    .object({ type: z.literal("review"), evidenceId: z.uuid().optional() })
    .strict(),
]);
export type WorkerCommand = z.input<typeof workerCommandSchema>;
export function sessionWorkerPaths(home: string, id: string) {
  const directory = join(home, "sessions", z.uuid().parse(id));
  if (Buffer.byteLength(join(directory, "worker.sock")) > 103)
    throw new Error("会话目录超过 Unix socket 路径长度，请配置较短的状态目录");
  return {
    directory,
    socket: join(directory, "worker.sock"),
    lock: join(directory, "worker.lock"),
    diagnostic: join(directory, "worker-startup.json"),
  };
}
// 一次请求只读一个应答；连接断开不代表取消后台已接受的操作。
export async function requestSessionWorker(
  home: string,
  id: string,
  command: WorkerCommand,
  options: { timeoutMs?: number | null; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  // 审查由阶段预算约束；停止允许收尾，普通查询保持短超时。
  const timeoutMs =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : command.type === "review"
        ? null
        : command.type === "stop"
          ? 180000
          : 5000;
  options.signal?.throwIfAborted();
  const line = JSON.stringify(workerCommandSchema.parse(command)) + "\n";
  return new Promise((resolve, reject) => {
    const socket = createConnection(sessionWorkerPaths(home, id).socket);
    socket.setEncoding("utf8"); // JSON中文可能跨多个网络数据块。
    let content = "";
    // 完整审查含冻结、配置检查及模型调用，由各阶段控制预算；不套普通RPC的5秒上限。
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            socket.destroy(new Error("会话后台请求超时"));
          }, timeoutMs);
    let settled = false;
    const cancel = () =>
      finish(new DOMException("客户端已停止等待", "AbortError"));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      if (!settled) socket.write(line);
    });
    socket.on("data", (chunk) => {
      content += chunk.toString();
      if (Buffer.byteLength(content) > 5_000_000)
        return finish(new Error("后台应答超过容量预算"));
      const end = content.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(content.slice(0, end)) as {
          ok: boolean;
          result: Record<string, unknown>;
          error: string;
        };
        if (!response.ok) finish(new Error(response.error));
        else finish(undefined, response.result);
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.once("end", () => {
      if (!content.includes("\n")) finish(new Error("会话后台未返回完整应答"));
    });
  });
}
