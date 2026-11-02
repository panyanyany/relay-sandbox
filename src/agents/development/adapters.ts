import type { AgentType } from "../../config/schema.js";
import type { DevelopmentAdapter } from "./contract.js";
import { codexAdapter } from "./codex.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { opencodeAdapter } from "./opencode.js";
const adapters: Record<AgentType, DevelopmentAdapter> = {
  codex: codexAdapter,
  "claude-code": claudeCodeAdapter,
  opencode: opencodeAdapter,
};
// 固定注册表，不进行动态插件发现或失败时切换上游。
export function developmentAdapter(type: AgentType): DevelopmentAdapter {
  return adapters[type];
}
