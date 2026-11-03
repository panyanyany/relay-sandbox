import { TaskSubscriptions } from "./task-subscriptions.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { validateId } from "../projects/registry.js";
import { taskSnapshot } from "../tasks/wait.js";
import { formatError, redact } from "../audit/redaction.js";

// URI 只接受规范任务标识，不能将资源订阅变成任意宿主文件监听。
export function taskEventUri(id: string) {
  validateId(id);
  return `relay-sandbox://tasks/${id}`;
}
function taskId(uri: string) {
  const match = /^relay-sandbox:\/\/tasks\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (!match) throw new Error("任务资源 URI 非法");
  validateId(match[1]!);
  return match[1]!;
}
// 协议与工具共用连接级订阅管理，成功、取消和故障使用同一状态规则。
export function registerTaskEvents(server: McpServer, home: string) {
  const subscriptions = new TaskSubscriptions(home, (uri) =>
    server.server.sendResourceUpdated({ uri }),
  );
  const subscribe = (uri: string) => subscriptions.subscribe(uri, taskId(uri));
  const unsubscribe = (uri: string) => subscriptions.unsubscribe(uri);
  server.registerTool(
    "get_task_event_subscription",
    {
      description:
        "查询当前连接的任务订阅状态：absent、initializing、active或failed；失败含阶段和时间，须改用等待或查询，修复后显式重订阅。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(subscriptions.status(taskEventUri(id))),
        },
      ],
    }),
  );
  server.registerResource(
    "task-status",
    new ResourceTemplate("relay-sandbox://tasks/{id}", { list: undefined }),
    {
      description:
        "中转沙箱任务快照；订阅更新通知后重新读取，包含revision和nextAction。",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: redact(
            JSON.stringify(await taskSnapshot(home, taskId(uri.href))),
          ),
        },
      ],
    }),
  );
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(
    SubscribeRequestSchema,
    async ({ params }) => {
      await subscribe(params.uri);
      return {};
    },
  );
  server.server.setRequestHandler(
    UnsubscribeRequestSchema,
    async ({ params }) => {
      taskId(params.uri);
      unsubscribe(params.uri);
      return {};
    },
  );
  // 工具入口允许宿主 AI 显式选择事件方式；是否自动续接仍由客户端决定。
  for (const [name, description, operation] of [
    [
      "subscribe_task_events",
      "订阅任务资源更新通知；收到事件后读取资源或get_task。客户端须支持通知消费，不能保证自动唤醒AI。",
      subscribe,
    ],
    [
      "unsubscribe_task_events",
      "取消当前连接的任务事件订阅，不停止任务。",
      unsubscribe,
    ],
  ] as const) {
    server.registerTool(
      name,
      { description, inputSchema: { id: z.string() } },
      async ({ id }) => {
        try {
          const uri = taskEventUri(id);
          await operation(uri);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ...subscriptions.status(uri),
                }),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: formatError(error) }],
          };
        }
      },
    );
  }
  const previous = server.server.onclose;
  server.server.onclose = () => {
    subscriptions.close();
    previous?.();
  };
}
