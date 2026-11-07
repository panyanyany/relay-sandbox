import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../storage/files.js";
import { processIdentity } from "../tasks/lock.js";
// 原子发布完整身份；空文件或不合法归属必须报错，不能按文件年龄强行清理。
export const sessionIntentSchema = z
  .object({
    token: z.uuid(),
    pid: z.number().int().positive(),
    identity: z.string().min(1),
  })
  .strict();
export function stopIntentPath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "stop.intent");
}
export function recoveryIntentPath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "recovery.lock");
}
async function readIntent(path: string) {
  try {
    return sessionIntentSchema.parse(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export const readStopIntent = (home: string, id: string) =>
  readIntent(stopIntentPath(home, id));
// 启动worker及操作准入共同使用；仅显式恢复者持有随机令牌，不能凭同PID认领。
export async function assertRecoveryAdmission(
  home: string,
  id: string,
  token?: string,
) {
  const owner = await readIntent(recoveryIntentPath(home, id));
  if (!owner) return;
  if (
    token !== owner.token ||
    owner.pid !== process.pid ||
    owner.identity !== (await processIdentity(process.pid))
  )
    throw new Error("会话正在恢复或恢复未完成，不能启动新操作");
}
