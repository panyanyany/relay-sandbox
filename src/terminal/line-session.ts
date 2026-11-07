import { parseSessionInput } from "../sessions/commands.js";
import {
  runJsonSession,
  type JsonSessionOptions,
} from "../sessions/json-command.js";
import { createLineOutput } from "./line-output.js";

export interface LineSessionOptions extends Omit<
  JsonSessionOptions,
  "input" | "write" | "followUntilIdle"
> {
  sessionId?: string;
  input: AsyncIterable<string>;
  write(text: string): void | Promise<void>;
}

// 逐行入口仅转换输入和显示；保存、派发及多轮互斥沿用JSON会话控制层。
export async function runLineSession(options: LineSessionOptions) {
  const output = createLineOutput(options.write);
  // 显式续接身份随每次输入传递，由共享控制层验证并恢复同一会话。
  const identity = options.sessionId ? { sessionId: options.sessionId } : {};
  async function* requests() {
    for await (const line of options.input) {
      if (!line.trim()) continue;
      try {
        const command = parseSessionInput(line);
        yield JSON.stringify(
          command.type === "message" || command.type === "skill"
            ? { ...identity, request: command }
            : { ...identity, command: command.type },
        );
      } catch (error) {
        await output({
          type: "relay.error",
          phase: "input",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // 错误示范：退出时调用stop会取消网页仍在观察的同一后台任务。
  // 用无副作用help作为控制层首行，避免首次可恢复的命令错误中断整个终端。
  async function* input() {
    yield JSON.stringify({ ...identity, command: "help" });
    yield* requests();
  }
  return runJsonSession({
    ...options,
    input: input(),
    write: output,
    followUntilIdle: false,
  });
}
