import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { registerProject } from "../../src/projects/registry.js";
import { reserveTask, prepareTask } from "../../src/tasks/create.js";
import { startTask } from "../../src/tasks/start.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { taskSnapshot, waitTask } from "../../src/tasks/wait.js";
import { runTask } from "../../src/tasks/run.js";
import * as dispatch from "../../src/tasks/dispatch.js";
import * as workspace from "../../src/workspace/snapshot.js";
import * as acquire from "../../src/environments/acquire.js";
import * as install from "../../src/tasks/environment-install.js";
import * as monitor from "../../src/monitoring/monitor.js";
import * as cleanup from "../../src/tasks/cleanup.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-preparation-"));
  roots.push(root);
  const home = join(root, "state"),
    project = join(root, "project");
  await mkdir(project);
  await registerProject(home, "demo", project);
  await writeFile(
    join(home, "profiles", "relay-default.yaml"),
    stringify({
      endpoint: "https://example.test",
      model: "frozen-model",
      protocol: "responses",
      apiKeyEnv: "RELAY_PREPARATION_FIXTURE",
      image: `sha256:${"a".repeat(64)}`,
      networkImage: `sha256:${"a".repeat(64)}`,
    }),
  );
  vi.stubEnv("RELAY_PREPARATION_FIXTURE", "synthetic-preparation-key");
  return { home, project };
}
// 不用等真实60秒：将慢复制固定在可控门闩，确认返回和读取均不依赖它完成。
test("创建先返回游标，慢准备期间禁止派发及直接运行，完成后通知下一步", async () => {
  const { home, project } = await fixture();
  const dispatchSpy = vi
    .spyOn(dispatch, "dispatchOperation")
    .mockResolvedValue({
      taskId: "unused",
      workerPid: 1,
      status: "dispatched",
    });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredCopy = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const copy = vi.spyOn(workspace, "snapshot").mockImplementation(async () => {
    entered();
    await gate;
    return [];
  });
  const started = await startTask(home, "demo", "test");
  if (!("revision" in started)) throw new Error("创建未返回成功快照");
  expect(copy).not.toHaveBeenCalled();
  expect(started.environmentReady).toBe(false);
  expect(started.nextAction).toBe("wait_task");
  expect(dispatchSpy).toHaveBeenCalledWith(home, started.id, "initialize-task");
  dispatchSpy.mockRestore();
  // 修改项目配置不改变后台已冻结的配置。
  await writeFile(
    join(project, "relay-sandbox.yaml"),
    "developmentAgent:\n  profile: missing\n",
  );
  const acquireSpy = vi
    .spyOn(acquire, "acquireEnvironment")
    .mockImplementation(async (_home, task, profile) => {
      expect(profile.model).toBe("frozen-model");
      task.containerId = "fixture-container";
      return true;
    });
  const installSpy = vi
    .spyOn(install, "installEnvironment")
    .mockResolvedValue(
      {} as Awaited<ReturnType<typeof install.installEnvironment>>,
    );
  vi.spyOn(monitor, "startMonitor").mockResolvedValue(undefined);
  const preparing = prepareTask(home, started.id);
  try {
    await enteredCopy;
    await expect(dispatch.dispatchTask(home, started.id)).rejects.toThrow(
      "尚未准备就绪",
    );
    await expect(runTask(home, started.id)).rejects.toThrow("尚未准备就绪");
    expect((await getTask(home, started.id)).state).toBe("preparing");
    expect(acquireSpy).not.toHaveBeenCalled();
    await expect(cleanup.cleanupTask(home, started.id)).rejects.toThrow(
      "环境正在准备",
    );
  } finally {
    release();
  }
  const ready = await preparing;
  expect(ready.environmentReady).toBe(true);
  expect(ready.state).toBe("prepared");
  expect(installSpy).toHaveBeenCalled();
  const changed = await waitTask(home, started.id, started.revision, 1);
  expect(changed.environmentReady).toBe(true);
  expect(changed.nextAction).toBe("run_task");
});
test("已有容器但审计安装未完成时仍不能运行", async () => {
  const { home } = await fixture();
  const task = await reserveTask(home, "demo", "test");
  task.containerId = "partial-container";
  await saveTask(home, task);
  await expect(dispatch.dispatchTask(home, task.id)).rejects.toThrow(
    "尚未准备就绪",
  );
  expect((await taskSnapshot(home, task.id)).nextAction).toBe("wait_task");
});
test("准备异常持久化脱敏原因链并释放任务锁", async () => {
  const { home } = await fixture();
  const task = await reserveTask(home, "demo", "test");
  vi.spyOn(workspace, "snapshot").mockRejectedValue(
    new Error("复制失败 synthetic-preparation-key", {
      cause: new Error("根因"),
    }),
  );
  await expect(prepareTask(home, task.id)).rejects.toThrow("复制失败");
  const saved = await getTask(home, task.id);
  expect(saved.state).toBe("failed");
  expect(saved.environmentReady).toBe(false);
  expect(saved.error).toContain("根因");
  expect(saved.error).not.toContain("synthetic-preparation-key");
  await expect(prepareTask(home, task.id)).rejects.toThrow("状态不允许");
});
test("复制期间停止任务不会被后台重新标记就绪", async () => {
  const { home } = await fixture();
  const task = await reserveTask(home, "demo", "test");
  vi.spyOn(workspace, "snapshot").mockImplementation(async () => {
    const current = await getTask(home, task.id);
    current.state = "stopped";
    await saveTask(home, current);
    return [];
  });
  const stop = vi.spyOn(cleanup, "stopTaskResources");
  await expect(prepareTask(home, task.id)).rejects.toThrow("已被停止");
  expect((await getTask(home, task.id)).state).toBe("stopped");
  expect(stop).not.toHaveBeenCalled();
});

// PREP-002：取消先受理，再由复制流程释放资源；不能先删除仍被后台使用的目录。
test("慢复制响应跨调用取消，后台停止后可以清理", async () => {
  const { home } = await fixture();
  const task = await reserveTask(home, "demo", "test");
  let entered!: () => void;
  const copying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(workspace, "snapshot").mockImplementation(
    async (_root, _dest, _exclude, _max, signal) => {
      entered();
      return new Promise((resolve, reject) => {
        if (!signal) {
          reject(new Error("缺少取消信号"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  const preparing = prepareTask(home, task.id);
  await copying;
  const response = await cleanup.stopTask(home, task.id);
  expect(response).toMatchObject({ cancellationRequested: true });
  const stopped = await preparing;
  expect(stopped.state).toBe("stopped");
  expect(stopped.environmentReady).toBe(false);
  expect((await taskSnapshot(home, task.id)).task.cancellationRequested).toBe(
    true,
  );
});

test("取消后资源停止失败保持failed并保留两个原因", async () => {
  const { home } = await fixture();
  const task = await reserveTask(home, "demo", "test");
  vi.spyOn(workspace, "snapshot").mockResolvedValue([]);
  vi.spyOn(acquire, "acquireEnvironment").mockImplementation(
    async (_home, current) => {
      current.containerId = "partial-container";
      return true;
    },
  );
  let entered!: () => void, release!: () => void;
  const installing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(install, "installEnvironment").mockImplementation(async () => {
    entered();
    await gate;
    return {} as Awaited<ReturnType<typeof install.installEnvironment>>;
  });
  vi.spyOn(cleanup, "stopTaskResources").mockRejectedValue(
    new Error("模拟容器停止失败"),
  );
  const preparing = prepareTask(home, task.id);
  const rejected = expect(preparing).rejects.toBeInstanceOf(AggregateError);
  await installing;
  try {
    expect(await cleanup.stopTask(home, task.id)).toMatchObject({
      cancellationRequested: true,
    });
  } finally {
    release();
  }
  await rejected;
  const saved = await getTask(home, task.id);
  expect(saved.state).toBe("failed");
  expect(saved.error).toContain("用户已取消");
  expect(saved.error).toContain("模拟容器停止失败");
});
