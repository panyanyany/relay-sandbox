import type { SessionEventInput } from "../../sessions/events.js";
export interface OpenCodeReply {
  status: number;
  body: unknown;
}
export type OpenCodeRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<OpenCodeReply>;
// 所有执行入口收敛为同步消息；错误示范：message_async 收到 204 就释放锁。
export function createOpenCodeBridge(input: {
  nativeId: string;
  request: OpenCodeRequest;
  emit(event: SessionEventInput): Promise<unknown>;
}) {
  const base = `/session/${encodeURIComponent(input.nativeId)}`;
  async function message(body: unknown) {
    const text = (
      (body as { parts?: Array<{ type: string; text?: string }> })?.parts ?? []
    )
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (text)
      await input.emit({
        type: "message",
        payload: { role: "user", text, complete: true },
      });
    const reply = await input.request("POST", `${base}/message`, body);
    if (reply.status >= 400)
      throw new Error(`OpenCode 消息失败: HTTP ${reply.status}`);
    const data = reply.body as {
      info?: { id?: string; error?: unknown; finish?: string };
      parts?: Array<{ type: string; text?: string }>;
    };
    if (data.info?.error)
      throw new Error(`OpenCode 轮次失败: ${JSON.stringify(data.info.error)}`);
    if (!data.info?.finish) throw new Error("OpenCode 轮次未返回完成标记");
    const answer = (data.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    await input.emit({
      type: "message",
      payload: {
        role: "assistant",
        text: answer,
        complete: true,
        ...(data.info?.id ? { messageId: data.info.id } : {}),
      },
    });
    return reply;
  }
  return {
    async submit(prompt: string) {
      await message({ parts: [{ type: "text", text: prompt }] });
    },
  };
}
