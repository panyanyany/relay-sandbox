import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";
import { dispatchOperation } from "../../src/tasks/dispatch.js";
import { observeDockerEvents } from "../../src/monitoring/runtime-events.js";
import { recordStop } from "../../src/monitoring/termination.js";
import { sampleTask } from "../../src/monitoring/sample.js";

// 真实硬链接、超时停止与事件留证，不运行模型、不改动用户容器。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "硬链接产物独立重收集，超时停止留证且Docker事件可回溯",
  async () => {
    const docker = dockerClient(10000),
      id = randomUUID(),
      home = await mkdtemp(join(tmpdir(), "relay-exit-artifacts-"));
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const config = configSchema.parse({ environment: { mode: "ephemeral" } });
    const handle = await createRuntime(docker, id, image, image, config);
    const controller = new AbortController();
    const task: Task = {
      id,
      projectId: "p",
      projectRoot: "/unused",
      config,
      configDigest: "fixture",
      prompt: "fixture",
      state: "failed",
      error: "不支持的归档类型: link",
      round: 2,
      createdAt: "",
      updatedAt: "",
      checks: [],
      warnings: [],
      ...handle,
      environmentReady: true,
    };
    await saveTask(home, task);
    const observing = observeDockerEvents(home, task, controller.signal);
    try {
      const result = await execute(
        docker,
        handle.containerId,
        [
          "sh",
          "-c",
          "printf report > report.txt && ln report.txt report-copy.txt",
        ],
        {},
        5000,
        4096,
      );
      expect(result.exitCode).toBe(0);
      const dispatched = await dispatchOperation(home, id, "collect");
      expect(dispatched.status).toBe("dispatched");
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = await getTask(home, id);
        if (current.state === "checking") break;
        if (current.state === "failed")
          throw new Error(current.error ?? "后台收集失败");
        await setTimeout(50);
      }
      expect((await getTask(home, id)).round).toBe(2);
      expect((await getTask(home, id)).state).toBe("checking");
      const directory = join(home, "tasks", id, "result");
      expect(await readFile(join(directory, "report-copy.txt"), "utf8")).toBe(
        "report",
      );
      expect((await stat(join(directory, "report-copy.txt"))).ino).not.toBe(
        (await stat(join(directory, "report.txt"))).ino,
      );
      await writeFile(join(directory, "report-copy.txt"), "changed");
      expect(await readFile(join(directory, "report.txt"), "utf8")).toBe(
        "report",
      );
      const sampling = await sampleTask(task, new Map());
      expect(sampling.containers.some((entry) => "cgroup" in entry)).toBe(true);
      await expect(
        execute(
          docker,
          handle.containerId,
          ["sleep", "30"],
          {},
          100,
          4096,
          [],
          (stop) => recordStop(home, task, "timeout", stop),
        ),
      ).rejects.toThrow("超时");
      const telemetry = join(home, "tasks", id, "telemetry");
      expect(
        JSON.parse(
          await readFile(join(telemetry, "stop-timeout.json"), "utf8"),
        ),
      ).toMatchObject({ source: "timeout", status: "completed", round: 2 });
      let log = "";
      for (let n = 0; n < 100; n++) {
        try {
          log = await readFile(join(telemetry, "runtime-events.jsonl"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (log.includes('"stop"') || log.includes('"die"')) break;
        await setTimeout(50);
      }
      expect(log).toMatch(/"(?:stop|die)"/);
    } finally {
      controller.abort();
      await observing;
      await removeRuntime(docker, handle);
      await rm(home, { recursive: true, force: true });
    }
  },
  120000,
);

// 将故障限制在64MiB合成容器内，验证真实OOM事件，而非仅用137猜测原因。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实受限容器OOM事件与137关联，cgroup缺失如实报告",
  async () => {
    const docker = dockerClient(10000),
      id = randomUUID(),
      home = await mkdtemp(join(tmpdir(), "relay-oom-evidence-"));
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const config = configSchema.parse({
      environment: { mode: "ephemeral" },
      resources: { memoryMiB: 64, cpus: 1 },
    });
    const handle = await createRuntime(docker, id, image, image, config);
    const task: Task = {
      id,
      projectId: "p",
      projectRoot: "/unused",
      config,
      configDigest: "fixture",
      prompt: "fixture",
      state: "running",
      round: 1,
      createdAt: "",
      updatedAt: "",
      checks: [],
      warnings: [],
      ...handle,
    };
    const controller = new AbortController();
    const observing = observeDockerEvents(home, task, controller.signal);
    try {
      const result = await execute(
        docker,
        handle.containerId,
        ["python3", "-c", "data=bytearray(256*1024*1024)"],
        {},
        10000,
        4096,
      );
      expect(result.exitCode).toBe(137);
      let log = "";
      for (let n = 0; n < 100; n++) {
        try {
          log = await readFile(
            join(home, "tasks", id, "telemetry/runtime-events.jsonl"),
            "utf8",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (log.includes('"oom"')) break;
        await setTimeout(50);
      }
      expect(log).toContain('"oom"');
      const sample = await sampleTask(task, new Map());
      const main = sample.containers.find(
        (entry) => entry.id === handle.containerId,
      );
      if (!main || !("cgroup" in main)) throw new Error("缺少主容器采样");
      if (main.cgroup.coverage === "available")
        expect(main.cgroup.counts?.oom_kill).toBeGreaterThan(0);
      else expect(main.cgroup.reason).toBeTruthy();
    } finally {
      controller.abort();
      await observing;
      await removeRuntime(docker, handle);
      await rm(home, { recursive: true, force: true });
    }
  },
  120000,
);
