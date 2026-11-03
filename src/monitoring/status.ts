import type { RuntimeEventStatus } from "./runtime-events.js";
import type { StopRecord } from "./termination.js";
import { stopSources } from "./termination.js";
import { readPressure } from "./pressure.js";
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
  const optional = async <T = unknown>(path: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
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
    resourceWarnings: await readPressure(home, id),
    runtimeEvents: await optional<RuntimeEventStatus>(
      join(root, "telemetry/events-status.json"),
    ),
    execution: await optional<{
      time: string;
      round: number;
      exitCode: number;
      reason: string;
      note?: string;
    }>(join(root, "telemetry/execution.json")),
    stopHistory: (
      await Promise.all(
        stopSources.map((source) =>
          optional<StopRecord>(join(root, `telemetry/stop-${source}.json`)),
        ),
      )
    ).filter((record): record is StopRecord => record !== null),
    policy: task.config.logging,
  };
}
