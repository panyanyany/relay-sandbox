import type { NativeSessionAdapter } from "./contract.js";

// app-server只在容器执行；统一输入直接使用其结构化协议和原生线程。
export const codexSessionAdapter: NativeSessionAdapter = {
  agent: "codex",
  launch(context) {
    return {
      command: "codex",
      args: [
        "app-server",
        "-c",
        'model_provider="relay"',
        "-c",
        `model_providers.relay={ name="relay", base_url=${JSON.stringify(context.endpoint)}, wire_api="responses", env_key="RELAY_API_KEY" }`,
        "-c",
        `model=${JSON.stringify(context.model)}`,
      ],
      environment: context.environment,
    };
  },
  nativeSessionId(message) {
    const params = message.params as { thread?: { id?: string } } | undefined;
    return message.method === "thread/started" ? params?.thread?.id : undefined;
  },
  events(message) {
    const params = message.params as
      | {
          delta?: string;
          itemId?: string;
          item?: {
            id?: string;
            type?: string;
            text?: string;
            content?: Array<{ type: string; text?: string }>;
          };
        }
      | undefined;
    if (message.method === "item/agentMessage/delta" && params?.delta)
      return [
        {
          type: "message",
          payload: {
            role: "assistant",
            text: params.delta,
            complete: false,
            ...(params.itemId ? { messageId: params.itemId } : {}),
          },
        },
      ];
    if (
      message.method === "item/started" &&
      params?.item?.type === "userMessage"
    )
      return [
        {
          type: "message",
          payload: {
            role: "user",
            text: (params.item.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
            complete: true,
            ...(params.item.id ? { messageId: params.item.id } : {}),
          },
        },
      ];
    if (
      message.method === "item/completed" &&
      params?.item?.type === "agentMessage"
    )
      return [
        {
          type: "message",
          payload: {
            role: "assistant",
            text: params.item.text ?? "",
            complete: true,
            ...(params.item.id ? { messageId: params.item.id } : {}),
          },
        },
      ];
    return [];
  },
};
