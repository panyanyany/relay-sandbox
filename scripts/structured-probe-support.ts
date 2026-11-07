import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

export const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
// 探针仅继承PATH，私有HOME及所有凭据均为合成值。
export function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
}
// 所有进程有独立进程组与超时；最后等待退出，避免遗留serve或监听。
export async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  process.kill(-child.pid!, "SIGTERM");
  const kill = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* 进程已收尾。 */
    }
  }, 3000);
  try {
    await closed;
  } finally {
    clearTimeout(kill);
  }
}
export function start(binary: string, args: string[], root: string, env: NodeJS.ProcessEnv) {
  return spawn(binary, args, { cwd: join(root, "project"), env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}
export async function run(binary: string, args: string[], root: string, env: NodeJS.ProcessEnv) {
  const child = start(binary, args, root, env);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c));
  child.stderr.on("data", (c: Buffer) => (stderr += c));
  const timer = setTimeout(() => {
    void stop(child);
  }, 25000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
}
export const parse = (raw: string): Record<string, unknown>[] =>
  raw
    .split("\n")
    .filter((s) => s.startsWith("{"))
    .map((s) => JSON.parse(s) as Record<string, unknown>);

// 假协议服务仅返回合成文本，不转发网络请求。
export function createProbeProvider() {
  const calls: Array<{ path: string; body: unknown }> = [];
  const state = { rejectClaude: false };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = req.url ?? "";
    calls.push({ path, body });
    if (path.includes("count_tokens")) {
      res.end('{"input_tokens":10}');
      return;
    }
    if (path.includes("messages") && state.rejectClaude) {
      res.writeHead(401);
      res.end('{"error":{"type":"authentication_error","message":"synthetic first failure"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (path.includes("messages")) {
      emit("message_start", {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "FAKE_ACK" },
      });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      emit("message_stop", { type: "message_stop" });
    } else {
      const item = {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "FAKE_ACK", annotations: [] }],
      };
      const response = {
        id: "resp_fake",
        object: "response",
        status: "completed",
        model: body.model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      for (const [type, data] of [
        ["response.created", { response: { ...response, status: "in_progress", output: [] } }],
        ["response.output_item.added", { output_index: 0, item }],
        [
          "response.content_part.added",
          {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
        ],
        ["response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "FAKE_ACK" }],
        ["response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "FAKE_ACK" }],
        ["response.output_item.done", { output_index: 0, item }],
        ["response.completed", { response }],
      ] as const)
        emit(type, { type, ...data });
    }
    res.end();
  });
  return { server, calls, state };
}
