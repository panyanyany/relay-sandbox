import type { Command } from "commander";
import { resolve } from "node:path";
import { openDevelopmentSession } from "../sessions/environment.js";
import { openStartupContext } from "../sessions/startup-context.js";
import { createSessionActivation } from "../sessions/activation.js";
import { closeStartup } from "../sessions/startup-close.js";
import { ensureSessionReady } from "../sessions/readiness.js";
import {
  runJsonSession,
  type JsonSessionOptions,
} from "../sessions/json-command.js";
import { requestSessionWorker } from "../sessions/worker-api.js";
import { dispatchSessionWorker } from "../sessions/dispatch.js";
import { runLineSession } from "./line-session.js";
import { terminalLines } from "./line-input.js";
import { createLineOutput } from "./line-output.js";

// 连接只读检查；连接不存在才派发，不抢遗留归属锁。
export async function connectSessionWorker(home: string, id: string) {
  try {
    return await requestSessionWorker(home, id, { type: "status" });
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    return dispatchSessionWorker(home, id);
  }
}
export interface TerminalOptions {
  cwd?: string;
  session?: string;
  prompt?: string;
  model?: string;
  json?: boolean;
  inputJson?: boolean;
}
// 两端共享保存和派发通道；进入界面本身只读取授权配置。
export async function terminalChat(home: string, options: TerminalOptions) {
  if (options.model)
    throw new Error("开发模型由项目冻结配置选择，请通过中转配置修改模型");
  const cwd = resolve(options.cwd ?? process.cwd());
  let startup =
    options.session || options.inputJson
      ? undefined
      : await openStartupContext(home, { cwd });
  let activation = startup ? createSessionActivation(startup) : undefined;
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  process.on("SIGINT", disconnect);
  process.on("SIGTERM", disconnect);
  const display = createLineOutput((text) => {
    process.stdout.write(text);
  });
  const dependencies: Omit<JsonSessionOptions, "input" | "write"> = {
    signal: abort.signal,
    ...(!options.session
      ? {
          activate: async (request, onSaved) => {
            startup ??= await openStartupContext(home, { cwd });
            activation ??= createSessionActivation(startup);
            const { session } = await activation.submit(request, onSaved);
            return session;
          },
        }
      : {}),
    ensureSession: async ({ sessionId, onSession }) => {
      if (sessionId && options.session && sessionId !== options.session)
        throw new Error("输入会话编号与启动参数不一致");
      const id = sessionId ?? options.session;
      if (!id) throw new Error("续接缺少正式会话编号");
      const session = await openDevelopmentSession(home, {
        cwd,
        sessionId: id,
      });
      // 恢复必须等待真实Agent上下文，禁止发送暖机prompt或新建替代线程。
      await ensureSessionReady(home, session, () =>
        connectSessionWorker(home, session.id),
      );
      await onSession(session);
      return session;
    },
    readOnly: async (command) =>
      command === "status"
        ? { phase: "unstarted" }
        : {
            supported: false,
            reason: "尚未初始化开发Agent，原生能力查询暂不可用",
          },
    dispatch: (id) => connectSessionWorker(home, id),
    request: (id, command) =>
      requestSessionWorker(
        home,
        id,
        command,
        // 错误示范：用普通5秒RPC预算等待完整审查，会误报失败而后台仍在运行。
        command.type === "review" ? { signal: abort.signal } : {},
      ),
  };
  try {
    if (options.json || options.inputJson || options.prompt) {
      const input = options.prompt
        ? (async function* () {
            yield JSON.stringify({
              prompt: options.prompt,
              ...(options.session ? { sessionId: options.session } : {}),
            });
          })()
        : terminalLines(process.stdin, abort.signal);
      await runJsonSession({
        ...dependencies,
        input,
        write: async (event) => {
          if (options.json) console.log(JSON.stringify(event));
          else await display(event);
          if (event.type === "relay.error") process.exitCode = 1;
        },
      });
    } else {
      await runLineSession({
        ...dependencies,
        ...(options.session ? { sessionId: options.session } : {}),
        input: terminalLines(process.stdin, abort.signal),
        write: (text) => {
          process.stdout.write(text);
        },
      });
    }
  } finally {
    process.off("SIGINT", disconnect);
    process.off("SIGTERM", disconnect);
    // 错误示范：客户端退出清理正式worker，会中断网页仍在观察的开发请求。
    if (startup && activation?.close().cleanupStartup)
      await closeStartup(startup);
  }
}
// 无子命令进入逐行界面；chat 保留为网页与脚本调用入口。
export function registerChatCommand(program: Command, home: () => string) {
  const command = program
    .command("chat")
    .description("进入逐行开发会话或输出统一 JSONL");
  for (const target of [program, command]) {
    target
      .option("--cwd <path>", "项目目录")
      .option("--session <id>", "继续统一开发会话");
  }
  command
    .option("--prompt <text>", "发送一轮后离开观察")
    .option("--json", "输出 JSONL 事件")
    .option("--input-json", "从 stdin 读取 JSONL 输入")
    .option("--model <id>", "已停用；开发模型使用项目配置")
    .action((options: TerminalOptions) =>
      terminalChat(home(), { ...program.opts<TerminalOptions>(), ...options }),
    );
  program.action(() => terminalChat(home(), program.opts<TerminalOptions>()));
}
