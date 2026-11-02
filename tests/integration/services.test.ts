import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { startService } from "../../src/docker/services.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import type { Task } from "../../src/tasks/types.js";
// 同任务 localhost 可达；另一任务真实监听端口仍不可达。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "任务服务互通与跨任务拒绝",
  async () => {
    const docker = dockerClient(),
      image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect()).Id,
      config = configSchema.parse({});
    const first = await createRuntime(
        docker,
        randomUUID(),
        image,
        image,
        config,
      ),
      second = await createRuntime(docker, randomUUID(), image, image, config);
    const root = await mkdtemp(join(tmpdir(), "relay-service-"));
    let service: string | undefined;
    try {
      await mkdir(join(root, "services"));
      await writeFile(
        join(root, "services/web.yaml"),
        stringify({ image, argv: ["python3", "-m", "http.server", "18766"] }),
      );
      const task = {
        id: randomUUID(),
        containerId: first.containerId,
        config,
        state: "checking",
      } as Task;
      service = await startService(docker, root, task, "web");
      // curl 自带有界就绪重试，避免靠固定延时掩盖启动竞态。
      const local = await execute(
        docker,
        first.containerId,
        [
          "curl",
          "--retry",
          "5",
          "--retry-connrefused",
          "--retry-delay",
          "1",
          "--max-time",
          "2",
          "http://127.0.0.1:18766",
        ],
        {},
        15000,
        4096,
      );
      expect(local.exitCode, local.output).toBe(0);
      const info = await docker.getContainer(first.containerId).inspect();
      const address = Object.values(info.NetworkSettings.Networks)[0]!
        .IPAddress;
      const cross = await execute(
        docker,
        second.containerId,
        [
          "curl",
          "--noproxy",
          "*",
          "--connect-timeout",
          "2",
          `http://${address}:18766`,
        ],
        {},
        5000,
        4096,
      );
      expect(cross.exitCode).not.toBe(0);
    } finally {
      if (service) await docker.getContainer(service).remove({ force: true });
      await removeRuntime(docker, first);
      await removeRuntime(docker, second);
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
