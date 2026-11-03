import { freezePolicy } from "../../src/permissions/freeze.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { dispatchOperation } from "../../src/tasks/dispatch.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { taskNextAction } from "../../src/tasks/guidance.js";
const calls = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: calls.spawn,
}));
const homes: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-resume-dispatch-"));
  homes.push(home);
  await saveTask(home, {
    id: "task",
    projectId: "project",
    projectRoot: "/unused",
    containerId: "container",
    networkId: "network",
    prompt: "fixture",
    config: configSchema.parse({}),
    configDigest: "fixture",
    state: "stopped",
    createdAt: "",
    updatedAt: "",
    round: 1,
    warnings: [],
    checks: [],
    environmentReady: true,
    failureStage: "collection",
    artifactDigest: "old",
  });
  return home;
}
// 只替换进程创建，真实验证派发交接状态；不等待模型或 Docker 工作完成。
test("恢复立即返回后台进程标识并可等待，重复派发被拒绝", async () => {
  const home = await fixture();
  calls.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      unref: vi.fn(),
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const result = await dispatchOperation(home, "task", "resume");
  expect(result).toMatchObject({
    taskId: "task",
    status: "dispatched",
    workerPid: 123,
  });
  const task = await getTask(home, "task");
  expect(task.recoveryPending).toBe(true);
  expect(task.failureStage).toBeUndefined();
  expect(task.artifactDigest).toBeUndefined();
  expect(taskNextAction(task)).toBe("wait_task");
  expect(calls.spawn.mock.calls[0]![1]).toEqual(
    expect.arrayContaining(["resume-background", "task"]),
  );
  await expect(dispatchOperation(home, "task", "resume")).rejects.toThrow(
    "不可恢复",
  );
});
test("恢复派发失败清除交接标记并留下原始错误", async () => {
  const home = await fixture();
  calls.spawn.mockImplementation(() => {
    throw new Error("synthetic spawn failure");
  });
  await expect(dispatchOperation(home, "task", "resume")).rejects.toThrow(
    "synthetic spawn failure",
  );
  const task = await getTask(home, "task");
  expect(task.state).toBe("failed");
  expect(task.recoveryPending).toBeUndefined();
  expect(task.error).toContain("synthetic spawn failure");
});

// MCP 与同步 CLI 的直接挂载恢复一致：清单仍用于核对，审核必须重做。
test("直接挂载恢复保留收集清单，废止候选绑定", async () => {
  const home = await fixture();
  await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({ project: { mode: "direct" } }),
  );
  const original = await getTask(home, "task");
  original.resultGeneration = "collected";
  original.candidateGeneration = "collected";
  original.deliveryPrepared = true;
  await saveTask(home, original);
  calls.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      unref: vi.fn(),
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await dispatchOperation(home, "task", "resume");
  const queued = await getTask(home, "task");
  expect(queued.artifactDigest).toBe("old");
  expect(queued.resultGeneration).toBe("collected");
  expect(queued.candidateGeneration).toBeUndefined();
  expect(queued.deliveryPrepared).toBe(false);
});
