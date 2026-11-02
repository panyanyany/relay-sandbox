import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { installEnvironment } from "../../src/tasks/environment-install.js";
import {
  loadMainEnvironment,
  saveEnvironmentState,
} from "../../src/tasks/environment-state.js";
import {
  stopEnvironments,
  refreshEnvironments,
} from "../../src/tasks/environment-lifecycle.js";

// 只停止本测试代理；普通开发、源配置与保留证据分别检查。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "环境退出降级、私钥回收与失败可重试",
  async () => {
    const docker = dockerClient(),
      taskId = randomUUID(),
      home = await mkdtemp(join(tmpdir(), "relay-lifecycle-"));
    const runtime = await createRuntime(
      docker,
      taskId,
      "relay-sandbox-dev:0.1.0",
      "relay-sandbox-dev:0.1.0",
      configSchema.parse({}),
      taskId,
      { network: { mode: "default-open", grants: [] } },
    );
    const policy = {
      schemaVersion: 1 as const,
      ...hostPermissionsSchema.parse({ decoys: { enabled: true } }),
    };
    const root = join(home, "tasks", taskId);
    const unrelated = await docker.createContainer({
      Image: "relay-sandbox-dev:0.1.0",
      Cmd: ["sleep", "infinity"],
      Labels: { "relay-sandbox.test": taskId },
    });
    try {
      await unrelated.start();
      const first = await installEnvironment(docker, {
        home,
        taskId,
        runtimeId: "initial",
        containerId: runtime.containerId,
        policy,
      });
      expect(first.summary.traffic).toBe("ready");
      const primary = await readFile(
        join(root, "decoys", "manifest.json"),
        "utf8",
      );
      const evidence = join(
        root,
        "traffic",
        "initial",
        "evidence",
        "events.jsonl",
      );
      await writeFile(evidence, '{"decoyId":"aws-01"}\n');
      await docker.getContainer(first.handle!.containerId).stop({ t: 1 });
      await refreshEnvironments(docker, home, taskId);
      const downgraded = await loadMainEnvironment(home, taskId);
      expect(downgraded?.summary.traffic).toBe("unavailable");
      expect(downgraded?.summary.gaps).toContain("proxy-unavailable");
      expect(downgraded?.handle).toBeUndefined();
      expect(downgraded?.summary.helperRoot).toBeUndefined();
      expect(
        (await docker.getContainer(runtime.containerId).inspect()).State
          .Running,
      ).toBe(true);
      await expect(
        stat(join(root, "traffic", "initial", "ca")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(evidence, "utf8")).toContain("aws-01");
      const resumed = await installEnvironment(docker, {
        home,
        taskId,
        runtimeId: "resumed",
        containerId: runtime.containerId,
        policy,
      });
      expect(resumed.summary.traffic).toBe("ready");
      const realProxy = resumed.handle!.containerId;
      // 损坏handle不得删除无关容器；真实孤儿代理仍按任务标签独立回收。
      resumed.handle!.containerId = unrelated.id;
      await saveEnvironmentState(home, taskId, resumed);
      await expect(stopEnvironments(docker, home, taskId)).rejects.toThrow();
      expect((await loadMainEnvironment(home, taskId))?.summary.traffic).toBe(
        "cleanup_pending",
      );
      expect((await unrelated.inspect()).State.Running).toBe(true);
      await expect(
        docker.getContainer(realProxy).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
      // 修正handle后可重试；半启动无summary目录的私钥也需删除，证据保留。
      resumed.handle!.containerId = realProxy;
      await saveEnvironmentState(home, taskId, resumed);
      const partial = join(root, "traffic", "partial");
      await mkdir(join(partial, "ca"), { recursive: true });
      await mkdir(join(partial, "private"));
      await writeFile(join(partial, "ca", "key.pem"), "fake-key");
      await writeFile(join(partial, "private", "manifest.json"), "fake-values");
      await stopEnvironments(docker, home, taskId);
      expect((await loadMainEnvironment(home, taskId))?.summary.traffic).toBe(
        "stopped",
      );
      await expect(stat(join(partial, "ca"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(partial, "private"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await readFile(join(root, "decoys", "manifest.json"), "utf8")) ===
          primary,
      ).toBe(true);
      expect(await readFile(evidence, "utf8")).toContain("aws-01");
    } finally {
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`relay-sandbox.task=${taskId}`] },
      });
      for (const container of containers)
        await docker
          .getContainer(container.Id)
          .remove({ force: true, v: true });
      await unrelated.remove({ force: true, v: true });
      await removeRuntime(docker, runtime);
      await rm(home, { recursive: true, force: true });
    }
  },
  90000,
);
