import { join } from "node:path";
import { profileSchema } from "../config/schema.js";
import { readCredential } from "../config/credentials.js";
import { codexAdapter } from "../agents/development/codex.js";
import { claudeCodeAdapter } from "../agents/development/claude-code.js";
import { opencodeAdapter } from "../agents/development/opencode.js";
import { readJson } from "../storage/files.js";
import { taskPath } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";

// 只读取任务冻结的开发档案；错误示范：展开 process.env 会泄露宿主审查凭据。
export async function sessionDevelopmentProfile(home: string, task: Task) {
  const profile = profileSchema.parse(
    await readJson(join(taskPath(home, task.id), "profile.json")),
  );
  const credential = await readCredential(home, profile);
  if (!credential) throw new Error("开发 Agent 的专用中转站凭据不可用");
  const adapter = {
    codex: codexAdapter,
    "claude-code": claudeCodeAdapter,
    opencode: opencodeAdapter,
  }[task.config.developmentAgent.type];
  // 复用既有适配器的协议校验和最小环境变量映射，不执行单轮命令。
  const { env } = adapter.launch("", profile, credential.key);
  if (task.config.developmentAgent.type === "opencode") {
    // serve 没有 run --model 参数，固定默认模型以免原生界面选中其他提供方。
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...JSON.parse(env.OPENCODE_CONFIG_CONTENT!),
      model: `relay/${profile.model}`,
    });
  }
  return { profile, env };
}
