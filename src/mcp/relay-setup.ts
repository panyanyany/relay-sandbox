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
import { formatError } from "../audit/redaction.js";
// 配置工具只接收非敏感参数；密钥由本机隐藏输入或受控私有模板录入。
export function registerRelaySetup(server: McpServer, home: string) {
  const result = async (operation: () => Promise<unknown>) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await operation()) },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatError(error) }],
      };
    }
  };
  server.registerTool(
    "initialize_relay",
    {
      description:
        "首次配置入口。只询问缺失的地址、模型和项目；新项目默认Claude Code，文件模板预填已有设置。用户明确选择目录后才传projectPath及confirmProject=true自动注册；conversation模式配置并返回隐藏录入命令，file模式创建私有中文模板。不要向用户罗列工具或JSON，不接收密钥。",
      inputSchema: initializeSchema,
    },
    (input) => result(() => initializeRelay(home, input)),
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
        "查询中转沙箱自己的模型配置。无project时列出已注册项目；有project时返回开发Agent、中转地址、模型、凭据就绪状态和隐藏输入命令，不返回密钥。不需要编辑容器的Claude设置或询问安装目录。",
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
