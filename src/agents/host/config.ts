import type { AgentType } from "../../config/schema.js";
// 只生成可审阅的接入配置，不覆盖用户现有 Agent 配置文件。
export function hostConfig(
  type: AgentType,
  entry: string,
  home: string,
  apiKeyEnv?: string,
): unknown {
  const args = [entry, "--home", home, "mcp"];
  if (type === "codex")
    return {
      type,
      toml: `[mcp_servers.relay-sandbox]\ncommand = "node"\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 60\ndefault_tools_approval_mode = "approve"\nenv_vars = ${JSON.stringify(apiKeyEnv ? [apiKeyEnv] : [])}\n`,
    };
  if (type === "claude-code")
    return {
      type,
      config: { mcpServers: { "relay-sandbox": { command: "node", args } } },
    };
  return {
    type,
    config: {
      mcp: {
        "relay-sandbox": {
          type: "local",
          command: ["node", ...args],
          enabled: true,
        },
      },
    },
  };
}
