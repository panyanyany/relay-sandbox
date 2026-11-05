import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { registerProject } from "../../src/projects/registry.js";
import { createIsolatedEphemeralTask as createTask } from "../helpers/ephemeral-task.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";
import { loadMainEnvironment } from "../../src/tasks/environment-state.js";
import { sampleTask } from "../../src/monitoring/sample.js";

// 从真实任务标签采样代理CPU和内存，不以开发容器指标代替辅助容器指标。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "辅助代理包含在真实任务指标中",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-traffic-metrics-"));
    const home = join(root, "state"),
      project = join(root, "project");
    let id: string | undefined;
    const previousKey = process.env.RELAY_METRICS_KEY;
    process.env.RELAY_METRICS_KEY = "synthetic-unused";
    try {
      await mkdir(project);
      await mkdir(join(home, "profiles"), { recursive: true });
      await mkdir(join(home, "permissions"));
      const image = (
        await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
      ).Id;
      await writeFile(
        join(home, "profiles/relay-default.yaml"),
        stringify({
          endpoint: "https://fixture.invalid/v1",
          model: "fixture",
          protocol: "responses",
          apiKeyEnv: "RELAY_METRICS_KEY",
          image,
          networkImage: image,
        }),
      );
      await writeFile(
        join(home, "permissions/fixture.yaml"),
        stringify({ decoys: { enabled: true } }),
      );
      await registerProject(home, "fixture", project);
      const task = await createTask(home, "fixture", "合成代理指标验证");
      id = task.id;
      const environment = await loadMainEnvironment(home, id);
      expect(environment?.summary.traffic).toBe("ready");
      const previous = new Map();
      await sampleTask(task, previous);
      const sample = await sampleTask(task, previous);
      const proxy = sample.containers.find(
        (container) => container.id === environment?.handle?.containerId,
      );
      expect(proxy?.metrics?.memoryUsageBytes).toBeGreaterThan(0);
      expect(proxy?.metrics?.cpuPercent).toBeTypeOf("number");
      expect(Number.isFinite(proxy?.metrics?.cpuPercent)).toBe(true);
      expect(
        sample.containers.some(
          (container) => container.id === task.containerId,
        ),
      ).toBe(true);
    } finally {
      if (id) await cleanupTask(home, id);
      await rm(root, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.RELAY_METRICS_KEY;
      else process.env.RELAY_METRICS_KEY = previousKey;
    }
  },
  60000,
);
