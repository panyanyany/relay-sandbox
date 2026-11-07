import { randomUUID } from "node:crypto";
import { mkdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJson, writeExclusiveJson } from "../storage/files.js";
import { withFinalizer } from "../storage/finalize.js";

import {
  developmentIdentitySchema,
  developmentSessionSchema,
  type CreateDevelopmentSession,
  type DevelopmentIdentity,
  type DevelopmentSession,
} from "../sessions/schema.js";

const sessionSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  cwd: z.string(),
  host: z.literal("codex"),
  nativeId: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TerminalSession = z.infer<typeof sessionSchema>;
export function sessionPath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "session.json");
}
// 会话绑定真实项目目录；恢复时不允许将宿主线程挪到另一个项目。
export async function openSession(home: string, cwd: string, id?: string) {
  const root = await realpath(cwd);
  if (id) {
    const session = sessionSchema.parse(await readJson(sessionPath(home, id)));
    if (session.cwd !== root) throw new Error("会话所属项目与当前目录不一致");
    return session;
  }
  const now = new Date().toISOString();
  const session: TerminalSession = {
    version: 1,
    id: randomUUID(),
    cwd: root,
    host: "codex",
    createdAt: now,
    updatedAt: now,
  };
  await saveSession(home, session);
  return session;
}
// 仅记录线程身份和时间；对话正文由宿主 Agent 原生会话保存。
export async function saveSession(home: string, session: TerminalSession) {
  session.updatedAt = new Date().toISOString();
  await writeJson(sessionPath(home, session.id), sessionSchema.parse(session));
}
// 同一会话只运行一轮；不自动抢占崩溃留下的锁。
export async function withSessionLock<T>(
  home: string,
  id: string,
  run: () => Promise<T>,
) {
  const lock = join(home, "sessions", z.uuid().parse(id), "turn.lock");
  await mkdir(join(home, "sessions", id), { recursive: true, mode: 0o700 });
  await writeExclusiveJson(lock, {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  return withFinalizer(run, () => unlink(lock));
}

// 新会话准备阶段尚无原生 ID；任务和环境关联可以由准备流程提供。
export async function createDevelopmentSession(
  home: string,
  input: CreateDevelopmentSession,
): Promise<DevelopmentSession> {
  const now = new Date().toISOString();
  const session = developmentSessionSchema.parse({
    ...input,
    cwd: await realpath(input.cwd),
    version: 2,
    kind: "development",
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  const path = sessionPath(home, session.id);
  await mkdir(join(home, "sessions", session.id), {
    recursive: true,
    mode: 0o700,
  });
  await writeExclusiveJson(path, session);
  return session;
}

// 统一识别旧版宿主历史；读取 Agent 身份也必须先遵循开发会话版本契约。
export function parseDevelopmentSession(record: unknown): DevelopmentSession {
  if (
    typeof record === "object" &&
    record !== null &&
    "version" in record &&
    record.version === 1
  ) {
    throw new Error(
      "旧版宿主会话不能作为开发会话恢复，请新建开发会话；旧历史仍保留",
    );
  }
  return developmentSessionSchema.parse(record);
}

// 恢复时校验调用方的可信项目身份，禁止把旧版宿主 nativeId 迁成开发上下文。
export async function readDevelopmentSession(
  home: string,
  id: string,
  expected: DevelopmentIdentity,
): Promise<DevelopmentSession> {
  const session = parseDevelopmentSession(
    await readJson(sessionPath(home, id)),
  );
  const identity = developmentIdentitySchema.parse(expected);
  const root = await realpath(identity.cwd);
  if (
    session.id !== id ||
    session.cwd !== root ||
    session.projectId !== identity.projectId ||
    session.agent !== identity.agent
  ) {
    throw new Error("开发会话所属目录、项目标识或 Agent 不一致");
  }
  return session;
}

// 原生身份只能首次绑定或重复确认，不能从一个原生上下文切换到另一个。
export async function bindNativeSession(
  home: string,
  id: string,
  expected: DevelopmentIdentity,
  nativeSessionId: string,
): Promise<DevelopmentSession> {
  return bindDevelopmentMetadata(home, id, expected, {
    nativeSessionId: z.string().min(1).parse(nativeSessionId),
  });
}

// 耗时准备之前固定任务归属，失败后仍能定位任务，不预设持久环境标识。
export async function bindDevelopmentTask(
  home: string,
  id: string,
  expected: DevelopmentIdentity,
  taskId: string,
): Promise<DevelopmentSession> {
  return bindDevelopmentMetadata(home, id, expected, {
    taskId: z.uuid().parse(taskId),
  });
}

// 先创建外部会话，待任务准备完成后再固定任务和环境关联。
export async function bindDevelopmentEnvironment(
  home: string,
  id: string,
  expected: DevelopmentIdentity,
  binding: { taskId: string; environmentId: string },
): Promise<DevelopmentSession> {
  return bindDevelopmentMetadata(home, id, expected, {
    taskId: z.uuid().parse(binding.taskId),
    environmentId: z.string().min(1).parse(binding.environmentId),
  });
}

// 独立元数据锁允许操作锁内绑定；错误示范：先读再无锁覆盖会串换原生上下文。
async function bindDevelopmentMetadata(
  home: string,
  id: string,
  expected: DevelopmentIdentity,
  binding: Partial<
    Pick<DevelopmentSession, "nativeSessionId" | "taskId" | "environmentId">
  >,
): Promise<DevelopmentSession> {
  const lock = join(home, "sessions", z.uuid().parse(id), "metadata.lock");
  await writeExclusiveJson(lock, {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  return withFinalizer(
    async () => {
      const session = await readDevelopmentSession(home, id, expected);
      for (const key of [
        "nativeSessionId",
        "taskId",
        "environmentId",
      ] as const) {
        if (
          binding[key] !== undefined &&
          session[key] !== undefined &&
          session[key] !== binding[key]
        ) {
          throw new Error("开发会话的原生会话、任务或环境标识已绑定，不能更换");
        }
      }
      const updated = developmentSessionSchema.parse({
        ...session,
        ...binding,
        updatedAt: new Date().toISOString(),
      });
      await writeJson(sessionPath(home, id), updated);
      return updated;
    },
    () => unlink(lock),
  );
}
