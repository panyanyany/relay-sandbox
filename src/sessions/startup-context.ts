import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig, loadProfile } from "../config/load.js";
import type { Config, Profile } from "../config/schema.js";
import { trustedProject } from "./environment.js";

export interface StartupResource {
  readonly kind: "process" | "connection";
  readonly id: string;
  // 由创建者捕获实际句柄；禁止根据猜测的PID或容器名称清理资源。
  readonly close: () => Promise<void> | void;
}

// 仅当前入口持有的临时对象，含清理句柄；不可整体序列化为正式会话。
export interface StartupContext {
  readonly startupId: string;
  readonly home: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly agent: Config["developmentAgent"]["type"];
  readonly config: Config;
  readonly profile: Profile;
  readonly diagnosticDirectory: string;
  readonly registerResource: (resource: StartupResource) => void;
  readonly resources: () => readonly StartupResource[];
}

// 打开只读上下文，不创建目录、正式会话、任务或容器，不读取模型密钥。
export async function openStartupContext(
  home: string,
  input: { cwd: string },
): Promise<StartupContext> {
  const project = await trustedProject(home, input.cwd);
  const config = await loadConfig(project.cwd);
  const profile = await loadProfile(home, config.developmentAgent.profile);
  const startupId = randomUUID();
  const resources: StartupResource[] = [];
  return {
    ...project,
    home,
    startupId,
    config,
    profile,
    agent: config.developmentAgent.type,
    // 此目录仅供后续供应方按需保存脱敏诊断；startupId不是正式sessionId。
    diagnosticDirectory: join(home, "startups", startupId),
    registerResource(resource) {
      if (
        resources.some(
          (owned) => owned.kind === resource.kind && owned.id === resource.id,
        )
      )
        throw new Error("启动资源已登记，不能重复持有清理权");
      resources.push(resource);
    },
    resources: () => [...resources],
  };
}
