import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { FileResource } from "../../src/permissions/types.js";
import {
  prepareResources,
  loadPreparedResources,
} from "../../src/resources/prepare.js";
import { dockerClient } from "../../src/docker/client.js";
import {
  createRuntime,
  removeRuntime,
  type RuntimeHandle,
} from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
// 使用真实 UID1000 和 Docker bind 验证，而不是 Mock mount 序列化结果。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "资源副本可用、直接只读拒写及可写立即影响源",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-resource-bind-"));
    const docker = dockerClient();
    let handle: RuntimeHandle | undefined;
    try {
      const resources: FileResource[] = [];
      for (const [name, mode, access] of [
        ["copy", "copy", "read-write"],
        ["readonly", "direct", "read-only"],
        ["writable", "direct", "read-write"],
      ] as const) {
        const source = join(root, name);
        await mkdir(source, { mode: 0o777 });
        await chmod(source, 0o777);
        await writeFile(join(source, "data"), "original", {
          mode: mode === "copy" ? 0o600 : 0o666,
        });
        resources.push({
          name,
          source,
          target: `/resources/${name}`,
          mode,
          access,
        });
      }
      const privateRoot = join(root, "private");
      const prepared = await prepareResources(resources, privateRoot);
      const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
        .Id;
      const id = randomUUID();
      handle = await createRuntime(
        docker,
        id,
        image,
        image,
        configSchema.parse({}),
        id,
        {
          mounts: prepared.mounts,
          network: { mode: "default-open", grants: [] },
        },
      );
      const run = (script: string) =>
        execute(
          docker,
          handle!.containerId,
          ["sh", "-c", script],
          {},
          5000,
          4096,
        );
      expect(
        (await run("echo denied > /resources/readonly/data")).exitCode,
      ).not.toBe(0);
      expect(
        (await run("echo changed > /resources/writable/data")).exitCode,
      ).toBe(0);
      expect(await readFile(join(root, "writable/data"), "utf8")).toBe(
        "changed\n",
      );
      expect((await run("cat /resources/copy/data")).output).toBe("original");
      expect((await run("echo local > /resources/copy/data")).exitCode).toBe(0);
      expect(await readFile(join(root, "copy/data"), "utf8")).toBe("original");
      expect((await stat(join(root, "copy/data"))).uid).toBe(process.getuid!());
      expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
      const reused = await loadPreparedResources(resources, privateRoot);
      expect(
        await readFile(join(reused.resources[0]!.source, "data"), "utf8"),
      ).toBe("local\n");
      expect(reused.mounts).toEqual(prepared.mounts);
      const mounts = (await docker.getContainer(handle.containerId).inspect())
        .HostConfig.Mounts;
      expect(mounts).toHaveLength(3);
      expect(JSON.stringify(mounts)).toContain('"NonRecursive":true');
      await removeRuntime(docker, handle);
      handle = undefined;
      await rm(privateRoot, { recursive: true });
      expect(await readFile(join(root, "readonly/data"), "utf8")).toBe(
        "original",
      );
      expect(await readFile(join(root, "writable/data"), "utf8")).toBe(
        "changed\n",
      );
    } finally {
      if (handle) await removeRuntime(docker, handle);
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
