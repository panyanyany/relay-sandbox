import { setTimeout } from "node:timers/promises";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { superviseOnce } from "./recovery.js";
import { processIdentity } from "./lock.js";
import { withFinalizer } from "../storage/finalize.js";
import { appendEvent } from "../storage/files.js";
// 独立进程监督器；仅回收本状态目录记录的任务，不扫描或操作其他项目资源。
export async function supervise(
  home: string,
  intervalSeconds: number,
  once = false,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "supervisor.lock");
  try {
    const owner = JSON.parse(await readFile(lock, "utf8")) as {
      pid: number;
      identity: string;
    };
    if ((await processIdentity(owner.pid)) === owner.identity)
      throw new Error("监督器已运行");
    await unlink(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(
    lock,
    JSON.stringify({
      pid: process.pid,
      identity: await processIdentity(process.pid),
    }),
    { flag: "wx", mode: 0o600 },
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await withFinalizer(
    async () => {
      do {
        const actions = await superviseOnce(home);
        if (actions.length)
          await appendEvent(join(home, "supervisor-events.jsonl"), {
            time: new Date().toISOString(),
            actions,
          });
        if (!once && !stopped) await setTimeout(intervalSeconds * 1000);
      } while (!once && !stopped);
    },
    async () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await unlink(lock);
    },
  );
}
