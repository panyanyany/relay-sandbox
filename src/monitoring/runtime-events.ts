import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { dockerClient } from "../docker/client.js";
import { taskPath } from "../tasks/store.js";
import { writeJson, readJson } from "../storage/files.js";
import { formatError } from "../audit/redaction.js";
import { appendBoundedLog } from "./log-store.js";
import type { Task } from "../tasks/types.js";

const actions = ["oom", "kill", "die", "stop", "start", "destroy", "exec_die"];
// 只持久化关联容器的最小字段；不保存Docker事件里的命令、标签内容或环境信息。
export function runtimeEvent(value: unknown, task: Task) {
  const event = value as {
    Type?: string;
    Action?: string;
    time?: number;
    timeNano?: number;
    Actor?: { ID?: string; Attributes?: Record<string, string> };
  };
  const attributes = event.Actor?.Attributes ?? {};
  const id = event.Actor?.ID;
  if (
    event.Type !== "container" ||
    !id ||
    !actions.includes(event.Action ?? "") ||
    (id !== task.containerId && attributes["relay-sandbox.task"] !== task.id)
  )
    return null;
  return {
    containerId: id,
    action: event.Action!,
    time: event.time ?? null,
    timeNano: event.timeNano ?? null,
    exitCode: /^\d+$/.test(attributes.exitCode ?? "")
      ? Number(attributes.exitCode)
      : null,
    signal: /^\d+$/.test(attributes.signal ?? "")
      ? Number(attributes.signal)
      : null,
  };
}
export interface RuntimeEventStatus {
  state: "connected" | "unavailable" | "stopped";
  updatedAt: string;
  lastEvent: ReturnType<typeof runtimeEvent>;
  lastIncident?: ReturnType<typeof runtimeEvent>;
  lastOom?: ReturnType<typeof runtimeEvent>;
  lastGap?: { updatedAt: string; error: string };
  error?: string;
}

// Docker事件流不受采样间隔限制；断流记录缺口并重连，不能把无事件当作未发生OOM。
export async function observeDockerEvents(
  home: string,
  task: Task,
  signal: AbortSignal,
) {
  const directory = join(taskPath(home, task.id), "telemetry");
  const status = join(directory, "events-status.json");
  const seen = new Set<string>();
  let since = Math.floor(Date.now() / 1000),
    lastEvent: ReturnType<typeof runtimeEvent> = null,
    lastIncident: ReturnType<typeof runtimeEvent> = null,
    lastOom: ReturnType<typeof runtimeEvent> = null;
  let lastGap: RuntimeEventStatus["lastGap"];
  // 重启保留宿主已保存的证据，历史事件以容器和原始时间标识，不冒充本轮。
  try {
    const previous = await readJson<RuntimeEventStatus>(status);
    lastEvent = previous.lastEvent;
    lastIncident = previous.lastIncident ?? null;
    lastOom =
      previous.lastOom ??
      (lastIncident?.action === "oom" ? lastIncident : null);
    lastGap = {
      updatedAt: new Date().toISOString(),
      error: "采集器重新启动，停止期间的事件覆盖不完整",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  while (!signal.aborted) {
    let stream: Readable | undefined;
    const abort = () => stream?.destroy();
    try {
      stream = (await dockerClient(10000).getEvents({
        since,
        filters: { type: ["container"], event: actions },
      })) as Readable;
      // 连接建立前保留请求超时；建立后允许事件流空闲，避免正常无事件被误报为断流。
      (stream as IncomingMessage).socket?.setTimeout(0);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) break;
      await writeJson(status, {
        state: "connected",
        since,
        updatedAt: new Date().toISOString(),
        lastEvent,
        lastIncident,
        lastOom,
        lastGap,
      });
      let buffer = "";
      const consume = async (line: string) => {
        if (!line.trim()) return;
        const event = runtimeEvent(JSON.parse(line), task);
        if (!event) return;
        const key = JSON.stringify(event);
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 256) seen.delete(seen.values().next().value!);
        await appendBoundedLog(
          join(directory, "runtime-events.jsonl"),
          event,
          task.config.logging,
        );
        if (event.time !== null) since = event.time;
        lastEvent = event;
        // 普通探针的exec_die=0不覆盖异常摘要，也不改变用户报告的关键事实。
        if (
          event.action === "oom" ||
          (["die", "exec_die"].includes(event.action) &&
            event.exitCode !== null &&
            event.exitCode !== 0)
        )
          lastIncident = event;
        if (event.action === "oom") lastOom = event;
        await writeJson(status, {
          state: "connected",
          updatedAt: new Date().toISOString(),
          lastEvent,
          lastIncident,
          lastOom,
          lastGap,
        });
      };
      for await (const chunk of stream) {
        buffer += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > 65536)
            throw new Error("Docker事件超过读取上限");
          await consume(line);
        }
        if (Buffer.byteLength(buffer) > 65536)
          throw new Error("Docker事件超过读取上限");
      }
      if (!signal.aborted) {
        await consume(buffer);
        throw new Error("Docker事件流已断开");
      }
    } catch (error) {
      if (signal.aborted) break;
      lastGap = {
        updatedAt: new Date().toISOString(),
        error: formatError(error),
      };
      const gap = {
        state: "unavailable",
        updatedAt: new Date().toISOString(),
        error: formatError(error),
        lastEvent,
        lastIncident,
        lastOom,
        lastGap,
      };
      await appendBoundedLog(
        join(directory, "runtime-events.jsonl"),
        { ...gap, kind: "coverage_gap" },
        task.config.logging,
      );
      await writeJson(status, gap);
      try {
        await setTimeout(1000, undefined, { signal });
      } catch (waiting) {
        if (!signal.aborted) throw waiting;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      stream?.destroy();
    }
  }
  await writeJson(status, {
    state: "stopped",
    updatedAt: new Date().toISOString(),
    lastEvent,
    lastIncident,
    lastOom,
    lastGap,
  });
}
