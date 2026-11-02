import type { DevelopmentAdapter } from "./contract.js";
// 独立核对本工具的协议和参数；密钥仅通过受控环境传入。
export const codexAdapter: DevelopmentAdapter = {
  type: "codex",
  launch(prompt, profile, key) {
    if (profile.protocol !== "responses")
      throw new Error("Codex 档案要求 Responses 协议");
    return {
      argv: [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_provider="relay"',
        "-c",
        `model_providers.relay={ name="relay", base_url=${JSON.stringify(profile.endpoint)}, wire_api="responses", env_key="RELAY_API_KEY" }`,
        "-m",
        profile.model,
        prompt,
      ],
      env: { RELAY_API_KEY: key },
    };
  },
};
