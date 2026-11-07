import type { SessionEventInput } from "../../sessions/events.js";
// 使用 CLI 的结构化协议，绝不从原生 ANSI 屏幕猜测忙闲状态。
export function claudeLaunch(input: {
  nativeId: string;
  model: string;
  settings: string;
  structured: boolean;
  resume: boolean;
  prompt?: string;
}) {
  const args = [
    "claude",
    input.resume ? "--resume" : "--session-id",
    input.nativeId,
    "--model",
    input.model,
    "--settings",
    input.settings,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ];
  if (input.structured)
    args.push(
      "-p",
      input.prompt ?? "",
      "--output-format",
      "stream-json",
      "--verbose",
    );
  return args;
}
export function claudeMessage(value: unknown): {
  events: SessionEventInput[];
  completed: boolean;
} {
  if (!value || typeof value !== "object")
    throw new Error("Claude 消息格式无效");
  const message = value as Record<string, unknown>;
  if (message.type === "result") {
    // 错误示范：退出码 0 和 is_error=false 不代表实际执行了开发轮次。
    if (
      message.prevent_continuation === true ||
      message.is_error === true ||
      message.num_turns === 0
    )
      throw new Error("Claude 轮次未执行或失败");
    return { events: [], completed: true };
  }
  const body = message.message as
    | {
        content?: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          tool_use_id?: string;
          is_error?: boolean;
        }>;
      }
    | undefined;
  const text = body?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  const tools: SessionEventInput[] = [];
  // 仅投影原生明确报告的工具状态，不推测未出现的完成事件。
  for (const part of body?.content ?? []) {
    if (part.type === "tool_use" && part.id && part.name)
      tools.push({
        type: "tool",
        payload: { name: part.name, callId: part.id, phase: "started" },
      });
  }
  return {
    events:
      message.type === "assistant" && text
        ? [
            {
              type: "message",
              payload: { role: "assistant", text, complete: true },
            },
            ...tools,
          ]
        : tools,
    completed: false,
  };
}
