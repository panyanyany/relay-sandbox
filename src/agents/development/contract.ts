import type { AgentType, Profile } from "../../config/schema.js";
export interface LaunchSpec {
  argv: string[];
  env: Record<string, string>;
}
export interface DevelopmentAdapter {
  type: AgentType;
  launch(prompt: string, profile: Profile, key: string): LaunchSpec;
}
