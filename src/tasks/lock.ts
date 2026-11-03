import { writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskPath, getTask } from "./store.js";
import { withFinalizer } from "../storage/finalize.js";
import { writeJson } from "../storage/files.js";
export interface OperationLease {
  pid: number;
  identity: string;
  expiresAt: string;
}
// Linux 进程启动时间用于区分 PID 复用，不能只按 PID 删除遗留锁。
export async function processIdentity(
  pid: number,
): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    // /proc 中的进程在打开与读取之间退出时也可能返回 ESRCH。
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined;
    throw error;
  }
}
// 每任务互斥并刷新租约；监督器只在确认过期后停止运行环境。
export async function withTaskLock<T>(
  home: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = join(taskPath(home, id), "operation.lock"),
    task = await getTask(home, id);
  const seconds = task.config.lifecycle.leaseSeconds;
  const lease: OperationLease = {
    pid: process.pid,
    identity: (await processIdentity(process.pid))!,
    expiresAt: "",
  };
  const refresh = () => {
    lease.expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    return { ...lease };
  };
  await writeFile(lock, JSON.stringify(refresh()), { flag: "wx", mode: 0o600 });
  let writes = Promise.resolve(),
    heartbeatError: unknown;
  const timer = setInterval(
    () => {
      writes = writes
        .then(() => writeJson(lock, refresh()))
        .catch((error) => {
          heartbeatError = error;
        });
    },
    (seconds * 1000) / 3,
  );
  return withFinalizer(operation, async () => {
    clearInterval(timer);
    await writes;
    await unlink(lock);
    if (heartbeatError)
      throw new Error("任务租约更新失败", { cause: heartbeatError });
  });
}
