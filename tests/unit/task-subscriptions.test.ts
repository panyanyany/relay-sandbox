import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configSchema } from "../../src/config/schema.js";
import * as snapshots from "../../src/tasks/wait.js";
import { TaskSubscriptions } from "../../src/mcp/task-subscriptions.js";
import { registerTaskEvents, taskEventUri } from "../../src/mcp/task-events.js";
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: vi.fn(),
}));

class Watcher extends EventEmitter {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const watchers: Watcher[] = [];
const snapshot: Awaited<ReturnType<typeof snapshots.taskSnapshot>> = {
  task: {
    environmentReady: false,
    cancellationRequested: false,
    resourceWarnings: [],
    id: "task",
    projectId: "project",
    projectRoot: "/unused",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "running",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
  },
  revision: "a".repeat(64),
  environmentReady: false,
  nextAction: "wait_task",
};
// 手动控制读取完成顺序，确定性覆盖并发和取消竞态，不依赖真实磁盘时序。
function pendingSnapshot() {
  let resolve!: (value: typeof snapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof snapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const uri = taskEventUri("task");
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(snapshots, "taskSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(watch).mockImplementation(() => {
    const watcher = new Watcher();
    watchers.push(watcher);
    // 只模拟测试实际消费的关闭和错误事件，变更回调由 mock 调用记录驱动。
    return watcher as FSWatcher;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  watchers.length = 0;
});
function change(index = 0) {
  const callback = vi.mocked(watch).mock.calls[index]![1];
  if (typeof callback !== "function") throw new Error("缺少目录监听回调");
  callback("rename", "task.json");
}

// 两个并发订阅共享一次初始化，损坏任务不能出现一成功一失败。
test("并发初始化共享失败，失败后可以重新订阅", async () => {
  const deferred = pendingSnapshot();
  vi.mocked(snapshots.taskSnapshot).mockReturnValueOnce(deferred.promise);
  const registry = new TaskSubscriptions("/unused", vi.fn());
  const first = registry.subscribe(uri, "task"),
    second = registry.subscribe(uri, "task");
  const result = Promise.allSettled([first, second]);
  expect(registry.status(uri).state).toBe("initializing");
  expect(watch).toHaveBeenCalledTimes(1);
  deferred.reject(new Error("broken task"));
  expect((await result).map((item) => item.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(registry.status(uri).state).toBe("absent");
  expect(watchers[0]!.close).toHaveBeenCalled();
  await registry.subscribe(uri, "task");
  expect(registry.status(uri).subscribed).toBe(true);
  registry.close();
});

test("旧初始化回滚和迟到错误不会删除取消后建立的新订阅", async () => {
  const deferred = pendingSnapshot();
  vi.mocked(snapshots.taskSnapshot).mockReturnValueOnce(deferred.promise);
  const registry = new TaskSubscriptions("/unused", vi.fn());
  const old = registry.subscribe(uri, "task");
  const rejected = expect(old).rejects.toThrow("old failure");
  registry.unsubscribe(uri);
  await registry.subscribe(uri, "task");
  deferred.reject(new Error("old failure"));
  await rejected;
  watchers[0]!.emit("error", new Error("late failure"));
  expect(registry.status(uri).state).toBe("active");
  expect(watchers[1]!.close).not.toHaveBeenCalled();
  registry.close();
});

test("监听故障有可查询状态、上下文和脱敏堆栈，显式订阅可恢复", async () => {
  const registry = new TaskSubscriptions("/unused", vi.fn());
  await registry.subscribe(uri, "task");
  change();
  watchers[0]!.emit("error", new Error("watch failure token=private-value"));
  expect(registry.status(uri)).toMatchObject({
    state: "failed",
    subscribed: false,
    failure: { stage: "watch" },
  });
  expect(vi.getTimerCount()).toBe(0);
  const diagnostic = String(vi.mocked(process.stderr.write).mock.calls[0]![0]);
  expect(diagnostic).toContain(uri);
  expect(diagnostic).toContain('"stage":"watch"');
  expect(diagnostic).toContain("task-subscriptions.test.ts");
  expect(diagnostic).not.toContain("private-value");
  await registry.subscribe(uri, "task");
  expect(registry.status(uri)).toMatchObject({
    state: "active",
    failure: null,
  });
  registry.close();
});

test("发送拒绝被处理且记录为独立失败阶段，不自动重试", async () => {
  const send = vi.fn().mockRejectedValue(new Error("send failure"));
  const registry = new TaskSubscriptions("/unused", send);
  await registry.subscribe(uri, "task");
  change();
  await vi.advanceTimersByTimeAsync(25);
  expect(registry.status(uri)).toMatchObject({
    state: "failed",
    failure: { stage: "send" },
  });
  expect(watchers[0]!.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(1);
  registry.close();
});

test("容量上限拒绝额外监听器，取消后释放容量", async () => {
  const registry = new TaskSubscriptions("/unused", vi.fn());
  for (let i = 0; i < 256; i++)
    await registry.subscribe(taskEventUri(`task-${i}`), `task-${i}`);
  await expect(registry.subscribe(uri, "task")).rejects.toThrow("256");
  expect(watch).toHaveBeenCalledTimes(256);
  registry.unsubscribe(taskEventUri("task-0"));
  await registry.subscribe(uri, "task");
  registry.close();
  expect(watchers.every((watcher) => watcher.close.mock.calls.length > 0)).toBe(
    true,
  );
});

// 内存传输断开时进程继续存活，排除退出进程自动回收资源造成的假通过。
test("连接断开立即释放监听器和待发送定时器", async () => {
  const server = new McpServer({ name: "events", version: "1" });
  registerTaskEvents(server, "/unused");
  const client = new Client({ name: "events-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = vi.spyOn(server.server, "sendResourceUpdated");
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.subscribeResource({ uri });
    const status = await client.callTool({
      name: "get_task_event_subscription",
      arguments: { id: "task" },
    });
    expect(status.content).toMatchObject([
      { text: expect.stringContaining('"state":"active"') },
    ]);
    change();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await client.close();
    expect(watchers[0]!.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});

// PREP-003：锁释放及取消标记属于快照事实，必须和task.json一样触发失效通知。
test.each([
  "operation.lock",
  "preparation-cancel.json",
  "resource-pressure.json",
])("%s变化触发任务资源通知", async (filename) => {
  const send = vi.fn(async () => {});
  const registry = new TaskSubscriptions("/unused", send);
  try {
    await registry.subscribe(uri, "task");
    const callback = vi.mocked(watch).mock.calls[0]![1];
    if (typeof callback !== "function") throw new Error("缺少目录监听回调");
    callback("rename", filename);
    await vi.advanceTimersByTimeAsync(30);
    expect(send).toHaveBeenCalledWith(uri);
  } finally {
    registry.close();
  }
});
