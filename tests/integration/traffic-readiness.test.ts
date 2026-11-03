import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { configSchema } from "../../src/config/schema.js";
import { ensureDecoyManifest } from "../../src/decoys/manifest.js";
import { startTraffic } from "../../src/traffic/runtime.js";

// 真实代理加载成功但没有请求钩子；模块版本与监听端口仍正常，功能探针必须拒绝。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "缺少剥离钩子的代理不能就绪且清理私密材料",
  async () => {
    const docker = dockerClient(),
      id = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "relay-readiness-"));
    const runtime = await createRuntime(
      docker,
      id,
      "relay-sandbox-dev:0.1.0",
      "relay-sandbox-dev:0.1.0",
      configSchema.parse({}),
      id,
      { network: { mode: "default-open", grants: [] } },
    );
    const addon = join(root, "noop.py");
    await writeFile(addon, '"""故障注入：没有任何请求处理钩子。"""\n');
    const create = docker.createContainer.bind(docker);
    const spy = vi
      .spyOn(docker, "createContainer")
      .mockImplementation(async (options) => {
        options!.HostConfig!.Mounts!.push({
          Type: "bind",
          Source: addon,
          Target: "/opt/relay/traffic-addon.py",
          ReadOnly: true,
        });
        return create(options!);
      });
    try {
      const manifest = await ensureDecoyManifest(
        join(root, "manifest.json"),
        id,
        { enabled: true, clients: [] },
      );
      await expect(
        startTraffic(docker, {
          taskId: id,
          developerContainerId: runtime.containerId,
          privateDirectory: join(root, "traffic"),
          manifest,
        }),
      ).rejects.toThrow("就绪超时");
      expect(
        await docker.listContainers({
          all: true,
          filters: {
            label: [
              `relay-sandbox.task=${id}`,
              "relay-sandbox.kind=traffic-proxy",
            ],
          },
        }),
      ).toHaveLength(0);
      const { access } = await import("node:fs/promises");
      await expect(access(join(root, "traffic/private"))).rejects.toThrow();
      await expect(access(join(root, "traffic/ca"))).rejects.toThrow();
    } finally {
      spy.mockRestore();
      await removeRuntime(docker, runtime);
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
