import { readStopIntent, assertRecoveryAdmission } from "./stop-intent.js";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeExclusiveJson } from "../storage/files.js";
import { withFinalizer } from "../storage/finalize.js";
import { processIdentity } from "../tasks/lock.js";
import { developmentSessionSchema } from "./schema.js";
import { beginSessionOperation, finishSessionOperation } from "./state.js";

const leaseSchema = z
  .object({
    token: z.uuid(),
    kind: z.enum(["development", "review", "stop", "prepare"]),
    pid: z.number().int().positive(),
    identity: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type SessionOperationLease = z.infer<typeof leaseSchema>;
export type SessionOperationKind = SessionOperationLease["kind"];
export class SessionBusyError extends Error {
  constructor() {
    super("会话忙碌，请在当前操作完成后重试");
    this.name = "SessionBusyError";
  }
}
export function sessionOperationPath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "operation.lock");
}
// 读取观察快照不代表获得修改权限；遗留锁由恢复流程判断，不在这里抢占。
export async function readSessionOperation(
  home: string,
  id: string,
): Promise<SessionOperationLease | undefined> {
  try {
    return leaseSchema.parse(await readJson(sessionOperationPath(home, id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
// 每次写状态或释放都校验随机令牌，拒绝的第二次输入不能释放第一轮的锁。
export async function assertSessionOperation(
  home: string,
  id: string,
  lease: SessionOperationLease,
): Promise<void> {
  const current = await readSessionOperation(home, id);
  if (!current || current.token !== lease.token || current.kind !== lease.kind)
    throw new Error("会话操作租约不匹配或已释放");
}
export async function acquireSessionOperation(
  home: string,
  id: string,
  kind: SessionOperationKind,
  options: { recoveryToken?: string } = {},
): Promise<SessionOperationLease> {
  developmentSessionSchema.parse(
    await readJson(join(home, "sessions", z.uuid().parse(id), "session.json")),
  );
  await assertRecoveryAdmission(
    home,
    id,
    kind === "prepare" ? options.recoveryToken : undefined,
  );
  if (kind !== "stop" && (await readStopIntent(home, id)))
    throw new Error("会话正在停止或停止未完成，需要显式恢复");
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("无法确定当前进程身份");
  const lease = leaseSchema.parse({
    token: randomUUID(),
    kind,
    pid: process.pid,
    identity,
    createdAt: new Date().toISOString(),
  });
  try {
    await writeExclusiveJson(sessionOperationPath(home, id), lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SessionBusyError();
    throw error;
  }
  try {
    await assertRecoveryAdmission(
      home,
      id,
      kind === "prepare" ? options.recoveryToken : undefined,
    );
    if (kind !== "stop" && (await readStopIntent(home, id)))
      throw new Error("会话正在停止或停止未完成，需要显式恢复");
    await beginSessionOperation(home, id, lease);
  } catch (error) {
    // 准入尚未交给调用方，安全释放自身锁；状态写入失败仍向上传递完整错误。
    return withFinalizer(
      async () => {
        throw error;
      },
      async () => {
        await assertSessionOperation(home, id, lease);
        await unlink(sessionOperationPath(home, id));
      },
    );
  }
  return lease;
}
export async function releaseSessionOperation(
  home: string,
  id: string,
  lease: SessionOperationLease,
): Promise<void> {
  await assertSessionOperation(home, id, lease);
  // 状态落盘失败保留锁，避免把仍不确定的会话伪装成可接受输入。
  await finishSessionOperation(home, id, lease);
  await unlink(sessionOperationPath(home, id));
}
export async function withSessionOperation<T>(
  home: string,
  id: string,
  kind: SessionOperationKind,
  run: (lease: SessionOperationLease) => Promise<T>,
  options: { recoveryToken?: string } = {},
): Promise<T> {
  const lease = await acquireSessionOperation(home, id, kind, options);
  return withFinalizer(
    () => run(lease),
    () => releaseSessionOperation(home, id, lease),
  );
}
