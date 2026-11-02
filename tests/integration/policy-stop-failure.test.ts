import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask } from "../../src/tasks/store.js";
import { stopTask } from "../../src/tasks/cleanup.js";
import type { Task } from "../../src/tasks/types.js";

// 只模拟指定自有容器的stop API 503；运行状态与其他容器停止均由真实Docker核对。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "停止API失败保留真实运行状态且继续停止其他容器",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-stop-failure-")),
      docker = dockerClient(),
      id = randomUUID();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const primary = await docker.createContainer({
      Image: image,
      Cmd: ["sleep", "infinity"],
      Labels: { "relay-sandbox.task": id },
      HostConfig: { NetworkMode: "none" },
    });
    const secondary = await docker.createContainer({
      Image: image,
      Cmd: ["sleep", "infinity"],
      Labels: { "relay-sandbox.task": id },
      HostConfig: { NetworkMode: "none" },
    });
    let restore: (() => void) | undefined;
    try {
      await primary.start();
      await secondary.start();
      const task: Task = {
        id,
        projectId: "fixture",
        projectRoot: "/unused",
        prompt: "fixture",
        config: configSchema.parse({}),
        configDigest: "fixture",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        round: 1,
        checks: [],
        warnings: [],
        containerId: primary.id,
      };
      await saveTask(home, task);
      const original = Docker.prototype.getContainer;
      const spy = vi
        .spyOn(Docker.prototype, "getContainer")
        .mockImplementation(function (this: Docker, containerId: string) {
          const container = original.call(this, containerId);
          if (containerId === primary.id)
            container.stop = () =>
              Promise.reject(
                Object.assign(new Error("synthetic stop API unavailable"), {
                  statusCode: 503,
                }),
              );
          return container;
        });
      restore = () => spy.mockRestore();
      await expect(stopTask(home, id)).rejects.toThrow(AggregateError);
      const failed = await getTask(home, id);
      expect(failed.state).toBe("running");
      expect(failed.error).toContain("synthetic stop API unavailable");
      expect(failed.warnings).toContain(
        "停止未完全成功，不能确认整个任务已停止",
      );
      expect((await primary.inspect()).State.Running).toBe(true);
      expect((await secondary.inspect()).State.Running).toBe(false);
      restore();
      restore = undefined;
      expect((await stopTask(home, id)).state).toBe("stopped");
      expect((await primary.inspect()).State.Running).toBe(false);
    } finally {
      restore?.();
      await primary.remove({ force: true });
      await secondary.remove({ force: true });
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
