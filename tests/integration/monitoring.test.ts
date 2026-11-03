import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, taskPath } from "../../src/tasks/store.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";
import { startMonitor } from "../../src/monitoring/monitor.js";
import { telemetryStatus } from "../../src/monitoring/status.js";
import { collectGarbage } from "../../src/tasks/garbage-collection.js";
import type { Task } from "../../src/tasks/types.js";

// 真实容器负载与 SIGKILL，验证独立宿主采集和正常/过期清理。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "周期指标、沙箱崩溃留证、采集器停止与到期回收",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-monitor-")),
      docker = dockerClient();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
        .Id,
      id = randomUUID();
    const config = configSchema.parse({
      logging: {
        sampleIntervalSeconds: 1,
        maxFileBytes: 4096,
        maxFiles: 2,
        memoryWarningPercent: 10,
        memoryWarningSeconds: 1,
      },
      resources: { memoryMiB: 256 },
    });
    const handle = await createRuntime(docker, id, image, image, config);
    const task: Task = {
      id,
      projectId: "p",
      projectRoot: "/unused",
      prompt: "x",
      config,
      configDigest: "c",
      state: "running",
      createdAt: "",
      updatedAt: "",
      round: 1,
      checks: [],
      warnings: [],
      ...handle,
    };
    try {
      await saveTask(home, task);
      await startMonitor(home, id);
      await execute(
        docker,
        handle.containerId,
        [
          "sh",
          "-c",
          "node -e 'const memory=Buffer.alloc(33554432,1); setInterval(()=>{const until=Date.now()+200;while(Date.now()<until){};if(memory[0]!==1)process.exit(1)},250)' >/tmp/load.log 2>&1 &",
        ],
        {},
        5000,
        4096,
      );
      let observed = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const status = await telemetryStatus(home, id),
          last = status.latest;
        if (
          last &&
          "containers" in last &&
          status.resourceWarnings.length > 0 &&
          last.containers.some(
            (c) =>
              c.metrics &&
              (c.metrics.cpuPercent ?? 0) > 5 &&
              (c.metrics.memoryUsageBytes ?? 0) > 33554432,
          )
        ) {
          observed = true;
          break;
        }
        await setTimeout(200);
      }
      expect(observed).toBe(true);
      await docker.getContainer(handle.containerId).kill({ signal: "SIGKILL" });
      let crashed = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const last = (await telemetryStatus(home, id)).latest;
        if (
          last &&
          "containers" in last &&
          last.containers.some(
            (c) => "running" in c && !c.running && c.exitCode === 137,
          )
        ) {
          crashed = true;
          break;
        }
        await setTimeout(200);
      }
      expect(crashed).toBe(true);
      expect(
        (await telemetryStatus(home, id)).runtimeEvents?.lastEvent,
      ).not.toBeNull();
      expect((await telemetryStatus(home, id)).running).toBe(true);
      const root = taskPath(home, id);
      await mkdir(join(root, "backup"));
      await writeFile(join(root, "backup/keep"), "original");
      await cleanupTask(home, id);
      expect((await telemetryStatus(home, id)).running).toBe(false);
      expect((await telemetryStatus(home, id)).latest).not.toBeNull();
      const logs = (await readdir(join(root, "telemetry"))).filter((n) =>
        n.startsWith("samples.jsonl"),
      );
      expect(logs.length).toBeLessThanOrEqual(2);
      for (const name of logs)
        expect(
          (await stat(join(root, "telemetry", name))).size,
        ).toBeLessThanOrEqual(4096);
      await expect(
        docker.getContainer(handle.containerId).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
      await collectGarbage(home, Date.now() + 8 * 86400000);
      expect(await readdir(join(root, "telemetry"))).toEqual([]);
      expect(await readFile(join(root, "backup/keep"), "utf8")).toBe(
        "original",
      );
    } finally {
      await cleanupTask(home, id);
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
