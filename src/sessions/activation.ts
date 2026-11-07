import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeExclusiveJson } from "../storage/files.js";
import { developmentSessionSchema, type DevelopmentSession } from "./schema.js";
import {
  executableSessionRequestSchema,
  type ExecutableSessionRequest,
} from "./requests.js";
import type { StartupContext } from "./startup-context.js";

export interface SessionActivation {
  readonly sessionId: string | undefined;
  submit<T>(
    request: ExecutableSessionRequest,
    execute: (
      session: DevelopmentSession,
      request: ExecutableSessionRequest,
    ) => Promise<T>,
  ): Promise<{ session: DevelopmentSession; result: T }>;
  close(): { cleanupStartup: boolean };
}

const activations = new WeakMap<StartupContext, SessionActivation>();

// 一次启动只接受一个首次请求；正式会话之后的并发由worker操作租约负责。
export function createSessionActivation(
  startup: StartupContext,
): SessionActivation {
  const existing = activations.get(startup);
  if (existing) return existing;
  let state: "open" | "submitting" | "accepted" | "failed" | "closed" = "open";
  let sessionId: string | undefined;
  const activation: SessionActivation = {
    get sessionId() {
      return sessionId;
    },
    async submit(request, execute) {
      const validated = executableSessionRequestSchema.parse(request);
      if (state === "closed") throw new Error("启动入口已关闭，不能提交请求");
      if (state !== "open") throw new Error("首次请求已提交，不能重复执行");
      // 此处在首个await之前抢占；关闭与提交按调用顺序确定唯一结果。
      state = "submitting";
      let session: DevelopmentSession;
      try {
        session = await publishActivation(startup, validated);
      } catch (error) {
        state = "failed";
        throw error;
      }
      sessionId = session.id;
      state = "accepted";
      // 错误示范：先调用Agent再保存ID，失败时就无法定位已发生的行为。
      const result = await execute(session, validated);
      return { session, result };
    },
    close() {
      if (state === "open" || state === "failed" || state === "closed") {
        state = "closed";
        return { cleanupStartup: true };
      }
      // 已准入的首提交和正式后台不属于客户端退出的清理范围。
      return { cleanupStartup: false };
    },
  };
  activations.set(startup, activation);
  return activation;
}

// 在同文件系统的启动目录写齐两份记录，再原子发布整个正式会话目录。
async function publishActivation(
  startup: StartupContext,
  request: ExecutableSessionRequest,
): Promise<DevelopmentSession> {
  const now = new Date().toISOString();
  const session = developmentSessionSchema.parse({
    version: 2,
    kind: "development",
    id: randomUUID(),
    projectId: startup.projectId,
    cwd: startup.cwd,
    agent: startup.agent,
    createdAt: now,
    updatedAt: now,
  });
  const stage = join(
    startup.home,
    "startups",
    startup.startupId,
    `activation-${session.id}`,
  );
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    // accepted只表示可靠接收，未承诺Agent已执行；恢复流程不得据此自动重放。
    await writeExclusiveJson(join(stage, "first-request.json"), {
      version: 1,
      sessionId: session.id,
      status: "accepted",
      acceptedAt: now,
      request,
    });
    await writeExclusiveJson(join(stage, "session.json"), session);
    await mkdir(join(startup.home, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    await rename(stage, join(startup.home, "sessions", session.id));
  } catch (error) {
    // 删除只针对本次专属暂存目录；不触及任何已发布会话或项目环境。
    try {
      await rm(stage, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "首次请求保存失败，暂存清理也失败",
      );
    }
    throw error;
  }
  return session;
}
