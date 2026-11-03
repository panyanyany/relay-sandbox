import { MemoryPressure, publishPressure } from "./pressure.js";
import { observeDockerEvents } from "./runtime-events.js";
import { ownsRuntime } from "../environments/ownership.js";
import { readFile, writeFile, unlink, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type Docker from "dockerode";
import { getTask, taskPath } from "../tasks/store.js";
import { processIdentity } from "../tasks/lock.js";
import { writeJson } from "../storage/files.js";
import { formatError } from "../audit/redaction.js";
import { sampleTask } from "./sample.js";
import { appendBoundedLog, pruneTelemetry } from "./log-store.js";
interface Owner {
  pid: number;
  identity: string;
}
// PID 和启动标识一起核对，避免误操作复用的进程。
async function owner(home: string, id: string): Promise<Owner | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(taskPath(home, id), "monitor.lock"), "utf8"),
    ) as Owner;
    return (await processIdentity(value.pid)) === value.identity
      ? value
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
// 独立宿主进程持续采样，沙箱停止或控制会话退出不影响日志保存。
export async function monitorTask(home: string, id: string) {
  if (await owner(home, id)) throw new Error("任务指标采集器已运行");
  const root = taskPath(home, id),
    lock = join(root, "monitor.lock");
  try {
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
  const controller = new AbortController(),
    previous = new Map<string, Docker.ContainerStats>();
  const pressure = new MemoryPressure();
  let eventFailure: unknown;
  const events = observeDockerEvents(
    home,
    await getTask(home, id),
    controller.signal,
  ).catch((error) => {
    eventFailure = error;
    controller.abort();
  });
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    do {
      const task = await getTask(home, id),
        directory = join(root, "telemetry");
      if (task.state === "cleaned" || !(await ownsRuntime(home, task))) break;
      const policy = task.config.logging;
      await pruneTelemetry(directory, policy.retentionDays);
      try {
        const sample = await sampleTask(task, previous, controller.signal);
        await appendBoundedLog(
          join(directory, "samples.jsonl"),
          sample,
          policy,
        );
        await writeJson(join(directory, "latest.json"), sample);
        await publishPressure(home, id, pressure.update(task, sample));
      } catch (error) {
        if (controller.signal.aborted) break;
        pressure.reset();
        await publishPressure(home, id, []);
        const failure = {
          time: new Date().toISOString(),
          taskId: id,
          kind: "sampling_error",
          error: formatError(error),
        };
        await appendBoundedLog(
          join(directory, "samples.jsonl"),
          failure,
          policy,
        );
        await writeJson(join(directory, "latest.json"), failure);
      }
      try {
        await setTimeout(policy.sampleIntervalSeconds * 1000, undefined, {
          signal: controller.signal,
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    } while (!controller.signal.aborted);
  } finally {
    controller.abort();
    await events;
    await publishPressure(home, id, []);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await unlink(lock);
    if (eventFailure)
      throw new Error("Docker事件采集失败", { cause: eventFailure });
  }
}
// 创建及恢复任务时启动；启动成功以宿主锁实际出现为准，不能仅依据 spawn。
export async function startMonitor(home: string, id: string) {
  if (await owner(home, id)) return;
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(
    new URL(source ? "../cli/main.ts" : "../cli/main.js", import.meta.url),
  );
  const log = await open(
    join(taskPath(home, id), "monitor-worker.log"),
    "a",
    0o600,
  );
  try {
    const child = spawn(
      process.execPath,
      [
        ...(source ? ["--import", "tsx"] : []),
        entry,
        "--home",
        home,
        "monitor",
        id,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    for (let count = 0; count < 100; count++) {
      if (await owner(home, id)) return;
      await setTimeout(100);
    }
    throw new Error("指标采集器启动失败，检查 monitor-worker.log");
  } finally {
    await log.close();
  }
}
// 收尾先停止采集再删除资源；最多等待当前 Docker 请求及一轮收尾。
export async function stopMonitor(home: string, id: string) {
  const running = await owner(home, id);
  if (!running) return;
  try {
    process.kill(running.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  for (let count = 0; count < 150; count++) {
    if (!(await owner(home, id))) return;
    await setTimeout(100);
  }
  throw new Error("指标采集器未及时停止，保留资源供排查");
}
