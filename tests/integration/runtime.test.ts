import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { upload, download } from "../../src/docker/archive.js";
import { configSchema } from "../../src/config/schema.js";
// 显式启用真实 Docker 验收；默认单元测试不依赖宿主容器权限。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实 Docker 权限、网络、归档与整容器超时",
  async () => {
    const docker = dockerClient();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const handle = await createRuntime(
      docker,
      randomUUID(),
      image,
      image,
      configSchema.parse({}),
    );
    const root = await mkdtemp(join(tmpdir(), "relay-docker-"));
    try {
      const info = await docker.getContainer(handle.containerId).inspect();
      expect(info.Config.User).toBe("1000:1000");
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      expect(info.HostConfig.CapDrop).toContain("ALL");
      expect(info.HostConfig.PidsLimit).toBe(256);
      expect(info.HostConfig.Memory).toBe(4096 * 1024 * 1024);
      await writeFile(join(root, "sample"), "contents");
      await upload(docker, handle.containerId, root);
      expect(
        (
          await execute(
            docker,
            handle.containerId,
            ["cat", "sample"],
            {},
            5000,
            4096,
          )
        ).output,
      ).toBe("contents");
      const network = await docker.getNetwork(handle.networkId).inspect();
      const gateway = network.IPAM?.Config?.[0]?.Gateway;
      for (const address of [gateway!, "10.1.2.3", "169.254.169.254"]) {
        const response = await execute(
          docker,
          handle.containerId,
          [
            "curl",
            "--noproxy",
            "*",
            "--connect-timeout",
            "2",
            `http://${address}:80`,
          ],
          {},
          5000,
          4096,
        );
        expect(response.exitCode).not.toBe(0);
      }
      const publicResult = await execute(
        docker,
        handle.containerId,
        [
          "curl",
          "--noproxy",
          "*",
          "-I",
          "--connect-timeout",
          "10",
          "https://example.com",
        ],
        {},
        20000,
        4096,
      );
      expect(publicResult.exitCode, publicResult.output).toBe(0);
      await download(docker, handle.containerId, join(root, "export"));
      expect(await readFile(join(root, "export/sample"), "utf8")).toBe(
        "contents",
      );
      const output = await execute(
        docker,
        handle.containerId,
        ["python3", "-c", 'print("x"*10000)'],
        {},
        5000,
        100,
      );
      expect(output.truncated).toBe(true);
      await expect(
        execute(docker, handle.containerId, ["sleep", "30"], {}, 100, 4096),
      ).rejects.toThrow();
      expect(
        (await docker.getContainer(handle.containerId).inspect()).State.Running,
      ).toBe(false);
    } finally {
      await removeRuntime(docker, handle);
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
