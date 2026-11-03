import {
  setRelayCredential,
  suppliedCredentialSchema,
} from "../config/relay-credential.js";
import {
  initializeRelay,
  initializeSchema,
  importRelayConfiguration,
} from "../config/relay-initialize.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  relayConfiguration,
  registeredRelayProjects,
  configureRelay,
  relaySetupSchema,
} from "../config/relay-setup.js";
import { checkRelayConfiguration } from "../config/relay-check.js";
import { formatError, redact } from "../audit/redaction.js";
// 先处理字符串值再序列化；错误示范：序列化后替换会漏掉转义密钥或破坏JSON。
function redactValues(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactValues(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValues(item, secrets),
      ]),
    );
  return value;
}
// 默认引导本机私有录入；用户主动提供密钥时直接保存，成功和失败均按实际值脱敏。
export function registerRelaySetup(server: McpServer, home: string) {
  const result = async (
    operation: () => Promise<unknown>,
    secrets: string[] = [],
  ) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(redactValues(await operation(), secrets)),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatError(error, secrets) }],
      };
    }
  };
  server.registerTool(
    "initialize_relay",
    {
      description:
        "首次配置入口。只询问缺失的地址、模型和项目；新项目默认Claude Code，文件模板预填已有设置。用户明确选择目录后才传projectPath及confirmProject=true自动注册；conversation模式可用apiKey保存用户主动提供的密钥并检查；未提供密钥时同时返回隐藏命令和credentialFile编辑路径。file模式创建私有中文模板。不主动索取聊天密钥，不重复要求录入；会话记录风险仅提醒一次。",
      inputSchema: initializeSchema,
    },
    (input) =>
      result(
        () => initializeRelay(home, input),
        input.apiKey ? [input.apiKey] : [],
      ),
  );
  server.registerTool(
    "set_relay_credential",
    {
      description:
        "用户主动在聊天提供已配置项目的密钥时直接保存并执行本机检查，无需CLI或重新提供地址模型；不主动索取聊天密钥，不回显密钥，提醒一次会话/工具记录可能保留。默认不联网。",
      inputSchema: z
        .object({ project: z.string(), apiKey: suppliedCredentialSchema })
        .strict(),
    },
    ({ project, apiKey }) =>
      result(() => setRelayCredential(home, project, apiKey), [apiKey]),
  );
  server.registerTool(
    "import_relay_configuration",
    {
      description:
        "用户填写私有模板并说填好了后调用。只接收项目标识，导入配置、转存密钥、清空模板密钥并执行本机检查；空密钥保留现有凭据，缺少凭据时要求填写；返回保存状态和实际来源，不返回密钥，不联网。",
      inputSchema: z.object({ project: z.string() }).strict(),
    },
    ({ project }) => result(() => importRelayConfiguration(home, project)),
  );
  server.registerTool(
    "get_relay_configuration",
    {
      description:
        "查询中转沙箱自己的模型配置。无project时列出已注册项目；有project时返回开发Agent、中转地址、模型、凭据就绪状态和隐藏输入命令，不返回密钥。缺少凭据时按credential.prepareFile准备模板，再同时展示文件实际路径和隐藏命令；用户已主动提供密钥时直接调用set_relay_credential。不需要编辑容器的Claude设置或询问安装目录。",
      inputSchema: { project: z.string().optional() },
    },
    ({ project }) =>
      result(() =>
        project
          ? relayConfiguration(home, project)
          : registeredRelayProjects(home),
      ),
  );
  server.registerTool(
    "configure_relay",
    {
      description:
        "按用户要求配置已注册项目的中转地址、模型和开发Agent；自动选择协议、复用可信本机镜像并保存独立模型档案。仅影响新任务，不修改权限或容器Claude设置；不接收密钥。",
      inputSchema: relaySetupSchema,
    },
    (input) => result(() => configureRelay(home, input)),
  );
  server.registerTool(
    "check_relay_configuration",
    {
      description:
        "默认本机检查模型档案、协议、凭据和镜像。仅用户明确要求联网验证时设置testConnection=true，向中转站发送小请求，可能计费；不返回密钥或响应正文。",
      inputSchema: {
        project: z.string(),
        testConnection: z.boolean().default(false),
      },
    },
    ({ project, testConnection }) =>
      result(() => checkRelayConfiguration(home, project, testConnection)),
  );
}
