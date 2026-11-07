import { stripVTControlCharacters } from "node:util";
import type { JsonSessionOutput } from "../sessions/json-protocol.js";

// 只转义终端控制码，保留真实换行；Agent输出不能清屏或改写终端标题。
export function createLineOutput(
  write: (text: string) => void | Promise<void>,
) {
  let partial = "";
  let partialId: string | undefined;
  const emit = (text: string) =>
    write(
      stripVTControlCharacters(text).replace(
        /[\u0000-\u0008\u000b-\u001f\u007f]/g,
        "",
      ),
    );
  return (event: JsonSessionOutput): void | Promise<void> => {
    if (event.type === "relay.session")
      return emit(`[会话 ${event.sessionId} · ${event.agent}]\n`);
    if (event.type === "relay.accepted") return emit("[已接受]\n");
    if (event.type === "relay.error")
      return emit(
        `[错误${event.phase ? ` · ${event.phase}` : ""}] ${event.message}\n`,
      );
    if (event.type === "relay.gap")
      return emit(`[事件缺口 ${event.from}–${event.to}] ${event.reason}\n`);
    if (event.type === "relay.readonly")
      return emit(
        `[${event.command}] ${typeof event.result === "string" ? event.result : JSON.stringify(event.result)}\n`,
      );
    const value = event.event;
    if (value.type === "message") {
      const payload = value.payload;
      if (payload.role !== "assistant") return;
      if (!payload.complete) {
        if (partialId !== payload.messageId) partial = "";
        partialId = payload.messageId;
        partial += payload.text;
        return emit(payload.text);
      }
      // 完成事件通常包含整段原文；已显示delta时仅补剩余部分，不制造逐字流。
      const remaining =
        partial &&
        partialId === payload.messageId &&
        payload.text.startsWith(partial)
          ? payload.text.slice(partial.length)
          : payload.text;
      partial = "";
      partialId = undefined;
      return emit(`${remaining}\n`);
    }
    if (value.type === "tool")
      return emit(
        `[工具 ${value.payload.name} · ${value.payload.phase}]${value.payload.text ? ` ${value.payload.text}` : ""}\n`,
      );
    if (value.type === "state")
      return emit(
        `[状态 ${value.payload.state}]${value.payload.detail ? ` ${value.payload.detail}` : ""}\n`,
      );
    if (value.type === "review")
      return emit(
        `[审查 ${value.payload.reviewId} · ${value.payload.state} · 证据 ${value.payload.evidenceVersion}] ${value.payload.detail ?? ""}\n`,
      );
    return emit(`[审计缺口] ${value.payload.reason}\n`);
  };
}
