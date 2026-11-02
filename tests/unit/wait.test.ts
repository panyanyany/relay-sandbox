import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { taskSnapshot, waitTask } from "../../src/tasks/wait.js";
import type { Task } from "../../src/tasks/types.js";

// 每例独立状态目录；无需 Docker，验证实际跨调用持久化边界。
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-wait-"));
  const task: Task = {
    id: "wait",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "c",
    state: "running",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
  };
  await saveTask(home, task);
  return {
    home,
    task,
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

test("等待捕获同状态的证据变化，旧游标立即返回最新结果", async () => {
  const f = await fixture();
  try {
    const first = await taskSnapshot(f.home, f.task.id);
    const waiting = waitTask(f.home, f.task.id, first.revision, 2);
    await setTimeout(30);
    f.task.warnings.push("审计部分覆盖");
    await saveTask(f.home, f.task);
    const changed = await waiting;
    expect(changed.reason).toBe("changed");
    expect(changed.nextAction).toBe("wait_task");
    expect(changed.task.state).toBe("running");
    expect(changed.task.warnings).toContain("审计部分覆盖");
    expect(changed.revision).not.toBe(first.revision);
    expect((await waitTask(f.home, f.task.id, first.revision, 1)).reason).toBe(
      "changed",
    );
  } finally {
    await f.dispose();
  }
});

test("无更新则有界超时，不改变任务或停止开发", async () => {
  const f = await fixture();
  try {
    const first = await taskSnapshot(f.home, f.task.id);
    const result = await waitTask(f.home, f.task.id, first.revision, 1);
    expect(result.reason).toBe("timeout");
    expect(result.revision).toBe(first.revision);
    expect((await getTask(f.home, f.task.id)).state).toBe("running");
  } finally {
    await f.dispose();
  }
});

test("取消只结束等待，非法参数及不存在任务明确报错", async () => {
  const f = await fixture();
  try {
    const first = await taskSnapshot(f.home, f.task.id);
    const controller = new AbortController();
    const waiting = waitTask(
      f.home,
      f.task.id,
      first.revision,
      5,
      controller.signal,
    );
    const rejected = expect(waiting).rejects.toThrow();
    controller.abort();
    await rejected;
    expect((await getTask(f.home, f.task.id)).state).toBe("running");
    await expect(waitTask(f.home, f.task.id, "bad", 1)).rejects.toThrow("游标");
    await expect(
      waitTask(f.home, f.task.id, first.revision, 56),
    ).rejects.toThrow("1–55");
    await expect(
      waitTask(f.home, "missing", first.revision, 1),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});
