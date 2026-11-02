import type { DevelopmentAdapter } from "./contract.js";
// 独立核对本工具的协议和参数；密钥仅通过受控环境传入。
export const opencodeAdapter: DevelopmentAdapter = {
  type: "opencode",
  launch(prompt, profile, key) {
    if (profile.protocol !== "openai-compatible")
      throw new Error("OpenCode 档案要求 OpenAI 兼容协议");
    return {
      argv: [
        "opencode",
        "run",
        "--auto",
        "--format",
        "json",
        "--model",
        `relay/${profile.model}`,
        prompt,
      ],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            relay: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: profile.endpoint, apiKey: key },
              models: { [profile.model]: {} },
            },
          },
        }),
      },
    };
  },
};
