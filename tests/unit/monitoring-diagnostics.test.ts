import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import type { Task } from "../../src/tasks/types.js";
import { cgroupMemory } from "../../src/monitoring/cgroup.js";
import {
  MemoryPressure,
  publishPressure,
  readPressure,
} from "../../src/monitoring/pressure.js";
import { recordStop } from "../../src/monitoring/termination.js";
import {
  observeDockerEvents,
  runtimeEvent,
} from "../../src/monitoring/runtime-events.js";
import type { TelemetrySample } from "../../src/monitoring/status.js";

const events = vi.hoisted(() => ({ getEvents: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({ dockerClient: () => events }));
function task(): Task {
  return {
    id: "task",
    projectId: "p",
    projectRoot: "/unused",
    config: configSchema.parse({}),
    configDigest: "x",
    prompt: "fixture",
    state: "running",
    createdAt: "",
    updatedAt: "",
    round: 2,
    checks: [],
    warnings: [],
    containerId: "abc",
  };
}
function sample(second: number, memoryPercent: number | null): TelemetrySample {
  return {
    schemaVersion: 1,
    time: new Date(second * 1000).toISOString(),
    taskId: "task",
    taskState: "running",
    round: 2,
    containers: [
      {
        id: "abc",
        name: "fixture",
        state: "running",
        running: true,
        exitCode: 0,
        oomKilled: false,
        restartCount: 0,
        cgroup: { coverage: "unavailable", reason: "fixture" },
        metrics: {
          cpuPercent: null,
          memoryUsageBytes: null,
          memoryLimitBytes: null,
          memoryPercent,
          pids: null,
          networkRxBytes: null,
          networkTxBytes: null,
          blockReadBytes: null,
          blockWriteBytes: null,
          memoryPeakBytes: null,
          memoryFailCount: null,
        },
      },
    ],
  };
}
// 瞬时尖峰、缺样和停止不累计为持续压力；提示不自动终止或扩容。
test("持续内存压力达到阈值才提醒，采样缺口和恢复会复位", () => {
  const pressure = new MemoryPressure(),
    t = task();
  for (const second of [0, 10, 20])
    expect(pressure.update(t, sample(second, 90))).toEqual([]);
  expect(pressure.update(t, sample(30, 90))[0]?.containerId).toBe("abc");
  expect(pressure.update(t, sample(40, null))).toEqual([]);
  expect(pressure.update(t, sample(50, 90))).toEqual([]);
  expect(pressure.update(t, sample(100, 90))).toEqual([]);
  expect(pressure.update(t, sample(110, 50))).toEqual([]);
});
test("cgroup只读经容器身份核对的v2路径，峰值缺失和权限不足明确报告", async () => {
  const read = vi.fn(async (path: string) =>
    path.endsWith("/cgroup")
      ? "0::/system.slice/docker-abc.scope\n"
      : path.endsWith("memory.events")
        ? "oom 2\noom_kill 1\nmax 4\n"
        : "4096\n",
  );
  expect(await cgroupMemory(12, "abc", read)).toMatchObject({
    coverage: "available",
    counts: { oom: 2, oom_kill: 1 },
    peakBytes: 4096,
  });
  expect(await cgroupMemory(12, "other", read)).toMatchObject({
    coverage: "unavailable",
    reason: "container_cgroup_identity_unconfirmed",
  });
  expect(
    await cgroupMemory(12, "abc", async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }),
  ).toMatchObject({ coverage: "unavailable", reason: "EACCES" });
});
test("停止诊断保存来源与结果，磁盘错误不能阻止真正的停止", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-stop-evidence-"));
  try {
    const t = task();
    await recordStop(home, t, "cancel", async () => "stopped");
    const path = join(home, "tasks/task/telemetry");
    expect(
      JSON.parse(await readFile(join(path, "stop-cancel.json"), "utf8")),
    ).toMatchObject({ source: "cancel", status: "completed", round: 2 });
    await expect(
      recordStop(home, t, "supervisor", async () => {
        throw new Error("stop failed");
      }),
    ).rejects.toThrow("stop failed");
    expect(
      JSON.parse(await readFile(join(path, "stop-supervisor.json"), "utf8")),
    ).toMatchObject({ status: "failed", source: "supervisor" });
    await rm(path, { recursive: true });
    await writeFile(path, "blocked");
    const stop = vi.fn(async () => undefined);
    await expect(recordStop(home, t, "timeout", stop)).rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("事件流保存最小OOM证据、过滤其他任务、关闭后释放连接", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-runtime-events-")),
    controller = new AbortController(),
    stream = Object.assign(new PassThrough(), {
      socket: { setTimeout: vi.fn() },
    });
  events.getEvents.mockResolvedValue(stream);
  const observing = observeDockerEvents(home, task(), controller.signal);
  try {
    await mkdir(join(home, "tasks/task"), { recursive: true });
    const event = {
      Type: "container",
      Action: "oom",
      time: 100,
      Actor: { ID: "abc", Attributes: { secret: "DO_NOT_SAVE" } },
    };
    expect(
      runtimeEvent({ ...event, Actor: { ID: "other" } }, task()),
    ).toBeNull();
    stream.write(JSON.stringify(event) + "\n");
    const path = join(home, "tasks/task/telemetry/runtime-events.jsonl");
    let log = "";
    for (let n = 0; n < 100; n++) {
      try {
        log = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (log.includes('"oom"')) break;
      await setTimeout(10);
    }
    expect(stream.socket.setTimeout).toHaveBeenCalledWith(0);
    expect(log).toContain('"oom"');
    expect(log).not.toContain("DO_NOT_SAVE");
    stream.write(
      JSON.stringify({
        ...event,
        Action: "exec_die",
        Actor: { ID: "abc", Attributes: { exitCode: "0" } },
      }) + "\n",
    );
    let summary: {
      lastEvent?: { action: string };
      lastIncident?: { action: string };
    } = {};
    for (let n = 0; n < 100; n++) {
      summary = JSON.parse(
        await readFile(
          join(home, "tasks/task/telemetry/events-status.json"),
          "utf8",
        ),
      );
      if (summary.lastEvent?.action === "exec_die") break;
      await setTimeout(10);
    }
    expect(summary.lastIncident?.action).toBe("oom");
    // 正常收尾不能把已有OOM替换成kill或成功退出。
    for (const action of ["kill", "die", "stop"])
      stream.write(
        JSON.stringify({
          ...event,
          Action: action,
          time: 101,
          Actor: { ID: "abc", Attributes: { exitCode: "0", signal: "15" } },
        }) + "\n",
      );
    for (let n = 0; n < 100; n++) {
      summary = JSON.parse(
        await readFile(
          join(home, "tasks/task/telemetry/events-status.json"),
          "utf8",
        ),
      );
      if (summary.lastEvent?.action === "stop") break;
      await setTimeout(10);
    }
    expect(summary.lastEvent?.action).toBe("stop");
    expect(summary.lastIncident?.action).toBe("oom");
    controller.abort();
    await observing;
    const restart = new AbortController();
    const restartedStream = new PassThrough();
    events.getEvents.mockResolvedValue(restartedStream);
    const restarted = observeDockerEvents(home, task(), restart.signal);
    try {
      for (let n = 0; n < 100; n++) {
        const status = JSON.parse(
          await readFile(
            join(home, "tasks/task/telemetry/events-status.json"),
            "utf8",
          ),
        );
        if (status.state === "connected") {
          expect(status.lastOom.action).toBe("oom");
          expect(status.lastIncident.action).toBe("oom");
          expect(status.lastGap.error).toContain("重新启动");
          break;
        }
        if (n === 99) throw new Error("重启未建立事件订阅");
        await setTimeout(10);
      }
    } finally {
      restart.abort();
      await restarted;
    }
    await publishPressure(home, "task", [
      { containerId: "abc", memoryPercent: 90, since: "now", message: "high" },
    ]);
    expect(await readPressure(home, "task")).toHaveLength(1);
  } finally {
    controller.abort();
    await observing;
    expect(stream.destroyed).toBe(true);
    await rm(home, { recursive: true, force: true });
  }
});
