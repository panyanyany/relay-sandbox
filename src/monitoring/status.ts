import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskPath, getTask } from "../tasks/store.js";
import { processIdentity } from "../tasks/lock.js";
import type { sampleTask } from "./sample.js";
export type TelemetrySample = Awaited<ReturnType<typeof sampleTask>>;
// 只读宿主固定位置；未产生指标时明确返回 null，不能把缺失数据当零值。
export async function telemetryStatus(home: string, id: string) {
  const task = await getTask(home, id),
    root = taskPath(home, id);
  const optional = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  };
  const latest = (await optional(join(root, "telemetry/latest.json"))) as
    | TelemetrySample
    | { kind: "sampling_error"; time: string; error: string }
    | null;
  const lock = (await optional(join(root, "monitor.lock"))) as {
    pid: number;
    identity: string;
  } | null;
  return {
    running: !!lock && (await processIdentity(lock.pid)) === lock.identity,
    latest,
    policy: task.config.logging,
  };
}
