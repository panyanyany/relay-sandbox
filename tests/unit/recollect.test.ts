import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { recollectTask } from "../../src/tasks/recollect.js";
import { taskNextAction } from "../../src/tasks/guidance.js";
import type { Task } from "../../src/tasks/types.js";
const collect = vi.hoisted(() => vi.fn());
vi.mock("../../src/tasks/run.js", () => ({ collectTask: collect }));
// 重试不能再次调用开发模型或把其他执行错误伪装成可收集任务。
test("收集失败可独立重试且轮次保持，执行失败拒绝", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-recollect-"));
  const task: Task = {
    id: "task",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "x",
    config: configSchema.parse({}),
    configDigest: "x",
    state: "failed",
    failureStage: "collection",
    round: 2,
    containerId: "abc",
    environmentReady: true,
    createdAt: "",
    updatedAt: "",
    checks: [],
    warnings: [],
  };
  try {
    await saveTask(home, task);
    expect(taskNextAction(task)).toBe("collect_artifacts");
    collect.mockImplementationOnce(async (_home: string, value: Task) => {
      value.state = "checking";
      delete value.failureStage;
      await saveTask(home, value);
      return value;
    });
    expect((await recollectTask(home, task.id)).round).toBe(2);
    expect((await getTask(home, task.id)).state).toBe("checking");
    task.failureStage = "execution";
    await saveTask(home, task);
    await expect(recollectTask(home, task.id)).rejects.toThrow(
      "仅产物收集失败",
    );
    expect(collect).toHaveBeenCalledOnce();
    task.failureStage = "collection";
    await saveTask(home, task);
    collect.mockImplementationOnce(async () => {
      const stopped = await getTask(home, task.id);
      stopped.state = "stopped";
      await saveTask(home, stopped);
      throw new Error("收集期间任务已停止");
    });
    await expect(recollectTask(home, task.id)).rejects.toThrow(
      "收集期间任务已停止",
    );
    expect((await getTask(home, task.id)).state).toBe("stopped");
    delete task.failureStage;
    task.error = "不支持的归档类型: link";
    expect(taskNextAction(task)).toBe("collect_artifacts");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
