import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendBoundedLog,
  pruneTelemetry,
} from "../../src/monitoring/log-store.js";
import {
  summarizeStats,
  type MetricsInput,
} from "../../src/monitoring/sample.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask } from "../../src/tasks/store.js";
import {
  collectGarbage,
  garbageCollectionPlan,
} from "../../src/tasks/garbage-collection.js";
import type { Task } from "../../src/tasks/types.js";

// 固定输入核对百分比口径与缺失指标，避免把采集不到误报为空闲。
test("CPU 按单核口径，内存按 Docker 原始用量，缺失指标返回 null", () => {
  const stats: MetricsInput = {
    cpu_stats: {
      cpu_usage: { total_usage: 200 },
      system_cpu_usage: 1000,
      online_cpus: 2,
    },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 600 },
    memory_stats: { usage: 256, limit: 512 },
    pids_stats: { current: 3 },
  };
  expect(summarizeStats(stats)).toMatchObject({
    cpuPercent: 50,
    memoryPercent: 50,
    memoryUsageBytes: 256,
    pids: 3,
    networkRxBytes: null,
    blockReadBytes: null,
  });
  expect(
    summarizeStats({
      cpu_stats: { cpu_usage: { total_usage: 0 } },
      memory_stats: {},
    }),
  ).toMatchObject({
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryPercent: null,
  });
});

test("指标按容量轮转、限定文件数，过期清理保留无关文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-log-policy-"));
  try {
    const path = join(root, "samples.jsonl"),
      policy = { maxFileBytes: 100, maxFiles: 2, retentionDays: 7 };
    for (let n = 0; n < 12; n++)
      await appendBoundedLog(path, { n, text: "x".repeat(35) }, policy);
    expect((await readdir(root)).length).toBe(2);
    expect(await readFile(path, "utf8")).toContain('"n":11');
    for (const file of await readdir(root))
      expect(
        Buffer.byteLength(await readFile(join(root, file))),
      ).toBeLessThanOrEqual(100);
    await writeFile(join(root, "keep.txt"), "keep");
    await writeFile(join(root, "latest.json"), "{}");
    const old = new Date(Date.now() - 8 * 86400000);
    for (const file of await readdir(root))
      if (file !== "keep.txt") await utimes(join(root, file), old, old);
    expect((await pruneTelemetry(root, 7)).length).toBe(3);
    expect(await readdir(root)).toEqual(["keep.txt"]);
    await expect(
      appendBoundedLog(path, { huge: "x".repeat(200) }, policy),
    ).rejects.toThrow("上限");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("过期日志与用户报告清理，任务元数据和代码备份保留；资源回收可预览", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-gc-"));
  try {
    const task: Task = {
      id: "gc",
      projectId: "p",
      projectRoot: "/unused",
      prompt: "x",
      config: configSchema.parse({}),
      configDigest: "c",
      state: "cleaned",
      createdAt: "",
      updatedAt: "",
      cleanedAt: new Date(0).toISOString(),
      round: 1,
      checks: [],
      warnings: [],
    };
    await saveTask(home, task);
    const root = join(home, "tasks/gc");
    await mkdir(join(root, "backup"));
    await writeFile(join(root, "backup/keep"), "original");
    for (const name of [
      "worker.log",
      "monitor-worker.log",
      "round-1.log",
      "audit.json",
      "user-report.json",
      "user-report-emission.json",
    ])
      await writeFile(join(root, name), "{}");
    await mkdir(join(root, "traffic/main/diagnostics"), { recursive: true });
    await writeFile(
      join(root, "traffic/main/diagnostics/traffic-tools-failed.json"),
      "{}",
    );
    expect((await garbageCollectionPlan(home))[0]?.action).toBe(
      "purge_reports",
    );
    expect(await collectGarbage(home)).toContain("reports-purged:gc");
    await expect(
      readFile(
        join(root, "traffic/main/diagnostics/traffic-tools-failed.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await getTask(home, "gc")).reportsPurgedAt).toBeTruthy();
    expect(await readFile(join(root, "backup/keep"), "utf8")).toBe("original");
    expect(await readdir(root)).not.toContain("worker.log");
    task.state = "failed";
    delete task.cleanedAt;
    delete task.reportsPurgedAt;
    await saveTask(home, task);
    expect(
      (await garbageCollectionPlan(home, Date.now() + 25 * 3600000))[0]?.action,
    ).toBe("cleanup_resources");
    expect((await getTask(home, "gc")).state).toBe("failed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
