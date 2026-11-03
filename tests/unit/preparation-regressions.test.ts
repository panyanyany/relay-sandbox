import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { writeJson } from "../../src/storage/files.js";
import { saveTask, getTask, taskPath } from "../../src/tasks/store.js";
import { withTaskLock } from "../../src/tasks/lock.js";
import { taskSnapshot, waitTask } from "../../src/tasks/wait.js";
import { resumeTask } from "../../src/tasks/recovery.js";
import { dispatchTask } from "../../src/tasks/dispatch.js";
import { startTask } from "../../src/tasks/start.js";
import { registerProject } from "../../src/projects/registry.js";
import * as restart from "../../src/tasks/restart.js";
vi.mock("../../src/tasks/restart.js", () => ({
  restartTaskRuntime: vi.fn(async () => {}),
}));
vi.mock("../../src/tasks/cleanup.js", async (original) => ({
  ...(await original<typeof import("../../src/tasks/cleanup.js")>()),
  stopTaskResources: vi.fn(async () => {}),
}));
vi.mock("../../src/monitoring/monitor.js", () => ({
  startMonitor: async () => {},
}));
const failures = vi.hoisted(() => ({ log: false, spawn: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (failures.log && String(args[0]).endsWith("worker.log"))
        throw new Error("日志打开失败", { cause: new Error("EACCES-fixture") });
      return actual.open(...args);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (!failures.spawn) return actual.spawn(...args);
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          "error",
          new Error("进程启动失败", { cause: new Error("spawn-fixture") }),
        ),
      );
      return child;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  failures.log = false;
  failures.spawn = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(ready = false) {
  const home = await mkdtemp(join(tmpdir(), "relay-prep-regress-"));
  roots.push(home);
  await saveTask(home, {
    id: "fixture",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "c",
    state: "failed",
    environmentReady: ready,
    containerId: "partial-container",
    networkId: "partial-network",
    createdAt: "",
    updatedAt: "",
    round: 0,
    checks: [],
    warnings: [],
  });
  const image = `sha256:${"a".repeat(64)}`;
  const profile = {
    endpoint: "https://example.test",
    model: "fixture",
    apiKeyEnv: "RELAY_PREP_REGRESSION",
    protocol: "responses",
    image,
    networkImage: image,
  };
  await writeJson(join(taskPath(home, "fixture"), "profile.json"), profile);
  return { home, profile };
}
// PREP-001：不能只把false改成true放行尚未上传完成的工作区。
test("首次准备不完整时拒绝普通恢复，完整环境恢复后进入prepared", async () => {
  const { home } = await fixture();
  await expect(resumeTask(home, "fixture")).rejects.toThrow("首次准备尚未完成");
  expect(restart.restartTaskRuntime).not.toHaveBeenCalled();
  const task = await getTask(home, "fixture");
  task.environmentReady = true;
  await saveTask(home, task);
  const restored = await resumeTask(home, "fixture");
  expect(restored.state).toBe("prepared");
  expect(restored.environmentReady).toBe(true);
});
// PREP-003：租约释放本身也须改变游标，不能靠睡眠避开就绪交接窗口。
test("准备锁未释放时不发布可运行指引，释放后等待能观察到变化", async () => {
  const { home } = await fixture(true);
  const task = await getTask(home, "fixture");
  task.state = "prepared";
  await saveTask(home, task);
  let revision = "";
  await withTaskLock(home, "fixture", async () => {
    const busy = await taskSnapshot(home, "fixture");
    revision = busy.revision;
    expect(busy.environmentReady).toBe(false);
    expect(busy.nextAction).toBe("wait_task");
    expect(await dispatchTask(home, "fixture")).toMatchObject({
      status: "busy",
      taskId: "fixture",
      nextAction: "wait_task",
    });
  });
  const ready = await waitTask(home, "fixture", revision, 1);
  expect(ready.reason).toBe("changed");
  expect(ready.environmentReady).toBe(true);
  expect(ready.nextAction).toBe("run_task");
});
// PREP-004：创建成功后，日志打开失败仍须给宿主一个可查询的任务ID。
test.each(["log", "spawn"] as const)(
  "派发%s失败仍返回任务ID和失败阶段及原因",
  async (failure) => {
    const { home, profile } = await fixture();
    const project = join(home, "project");
    await mkdir(project);
    await registerProject(home, "p", project);
    await writeJson(join(home, "profiles", "relay-default.yaml"), profile);
    vi.stubEnv(profile.apiKeyEnv, "synthetic-regression-key");
    failures[failure] = true;
    const response = await startTask(home, "p", "test");
    expect(response).toMatchObject({ status: "failed", stage: "dispatch" });
    expect(response.id).toBeTruthy();
    expect((await getTask(home, response.id)).state).toBe("failed");
    expect(JSON.stringify(response)).toContain(
      failure === "log" ? "EACCES-fixture" : "spawn-fixture",
    );
  },
);

// PREP-002：单个大文件也必须可中止，不能只在文件之间响应取消。
test("分块读取期间取消会关闭文件并停止继续复制", async () => {
  const { hashStable } = await import("../../src/workspace/stable-file.js");
  const { writeFile } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "relay-abort-copy-"));
  roots.push(home);
  await writeFile(join(home, "large.bin"), Buffer.alloc(128 * 1024));
  const controller = new AbortController();
  let chunks = 0;
  await expect(
    hashStable(
      home,
      "large.bin",
      async () => {
        chunks++;
        controller.abort(new Error("取消复制"));
      },
      Infinity,
      controller.signal,
    ),
  ).rejects.toThrow("取消复制");
  expect(chunks).toBe(1);
});
