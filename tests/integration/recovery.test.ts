import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask, taskPath } from "../../src/tasks/store.js";
import { superviseOnce, resumeTask } from "../../src/tasks/recovery.js";
import { writeJson } from "../../src/storage/files.js";
import type { Task } from "../../src/tasks/types.js";
// 注入已死亡的操作进程和到期租约，验证不依赖真实崩溃等待。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "失联停止、文件保留、恢复隔离、到期回收",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-recovery-")),
      docker = dockerClient(),
      image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect()).Id;
    const id = randomUUID(),
      config = configSchema.parse({}),
      handle = await createRuntime(docker, id, image, image, config);
    const task: Task = {
      id,
      projectId: "test",
      projectRoot: join(home, "project"),
      prompt: "fixture",
      config,
      configDigest: "config",
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      round: 1,
      checks: [],
      warnings: [],
      ...handle,
    };
    try {
      await mkdir(task.projectRoot);
      await mkdir(join(taskPath(home, id), "baseline"), { recursive: true });
      await writeFile(join(task.projectRoot, "host-new.txt"), "host update");
      await saveTask(home, task);
      const root = taskPath(home, id);
      await writeJson(join(root, "profile.json"), {
        endpoint: "http://127.0.0.1:18765/v1",
        model: "fixture",
        apiKeyEnv: "FAKE_KEY",
        protocol: "responses",
        image,
        networkImage: image,
      });
      await execute(
        docker,
        handle.containerId,
        ["sh", "-c", "echo retained > /workspace/file"],
        {},
        5000,
        4096,
      );
      await writeJson(join(root, "operation.lock"), {
        pid: 2147483647,
        identity: "missing",
        expiresAt: new Date(0).toISOString(),
      });
      task.state = "preparing";
      task.recoveryPending = true;
      task.recoveryDispatch = "stale-dispatch";
      task.workspaceOperation = true;
      await saveTask(home, task);
      expect(await superviseOnce(home)).toContain(`interrupted:${id}`);
      const supervised = await getTask(home, id);
      expect(supervised.recoveryPending).toBeUndefined();
      expect(supervised.workspaceOperation).toBeUndefined();
      await expect(resumeTask(home, id, "stale-dispatch")).rejects.toThrow(
        "任务不可恢复",
      );
      expect((await getTask(home, id)).state).toBe("interrupted");
      expect(
        (await docker.getContainer(handle.containerId).inspect()).State.Running,
      ).toBe(false);
      expect((await resumeTask(home, id)).state).toBe("prepared");
      expect(
        (
          await execute(
            docker,
            handle.containerId,
            ["cat", "file"],
            {},
            5000,
            4096,
          )
        ).output,
      ).toContain("retained");
      expect(
        (
          await execute(
            docker,
            handle.containerId,
            ["cat", "host-new.txt"],
            {},
            5000,
            4096,
          )
        ).output,
      ).toContain("host update");
      const running = await getTask(home, id);
      running.state = "running";
      await saveTask(home, running);
      await writeJson(join(root, "operation.lock"), {
        pid: 2147483647,
        identity: "missing",
        expiresAt: new Date(0).toISOString(),
      });
      await superviseOnce(home);
      const interrupted = await getTask(home, id);
      await writeFile(join(root, "audit.json"), "{}");
      await superviseOnce(home, Date.parse(interrupted.expiresAt!) + 1);
      expect((await getTask(home, id)).state).toBe("cleaned");
      expect(await readFile(join(root, "audit.json"), "utf8")).toBe("{}");
      await expect(
        docker.getContainer(handle.containerId).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await removeRuntime(docker, handle);
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
