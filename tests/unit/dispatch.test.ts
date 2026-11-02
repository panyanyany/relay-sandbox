import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask, taskPath } from "../../src/tasks/store.js";
import { writeJson } from "../../src/storage/files.js";
import { dispatchTask } from "../../src/tasks/dispatch.js";
import { processIdentity } from "../../src/tasks/lock.js";
// 实际后台进程快速返回；缺少专用凭据时状态失败，不停留在 queued 或回退宿主。
test("后台派发释放任务锁，早期配置错误可轮询", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-dispatch-")),
    id = "fixture",
    image = `sha256:${"a".repeat(64)}`;
  try {
    await saveTask(home, {
      id,
      projectId: "p",
      projectRoot: "/unused",
      prompt: "fixture",
      config: configSchema.parse({}),
      configDigest: "c",
      state: "preparing",
      createdAt: "",
      updatedAt: "",
      round: 0,
      checks: [],
      warnings: [],
      containerId: "unused",
    });
    await writeJson(join(taskPath(home, id), "profile.json"), {
      endpoint: "http://127.0.0.1:18765/v1",
      model: "fixture",
      apiKeyEnv: "RELAY_INTENTIONALLY_MISSING_TEST_KEY",
      protocol: "responses",
      image,
      networkImage: image,
    });
    const dispatched = await dispatchTask(home, id);
    expect(dispatched.status).toBe("dispatched");
    const deadline = Date.now() + 10000;
    while (await processIdentity(dispatched.workerPid!)) {
      if (Date.now() > deadline) throw new Error("测试后台进程没有及时退出");
      await setTimeout(50);
    }
    const task = await getTask(home, id);
    expect(task.state).toBe("failed");
    expect(task.error).toContain("凭据不可用");
    task.state = "stopped";
    await saveTask(home, task);
    await expect(dispatchTask(home, id)).rejects.toThrow("不允许派发");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
