import type { DevelopmentAdapter } from "./contract.js";
// 独立核对本工具的协议和参数；密钥仅通过受控环境传入。
export const claudeCodeAdapter: DevelopmentAdapter = {
  type: "claude-code",
  launch(prompt, profile, key) {
    if (profile.protocol !== "anthropic")
      throw new Error("Claude Code 档案要求 Anthropic 协议");
    return {
      argv: [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--model",
        profile.model,
      ],
      env: { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_API_KEY: key },
    };
  },
};
