import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { expect, test, vi } from "vitest";
import {
  createDevelopmentSession,
  bindNativeSession,
} from "../../src/terminal/session.js";
import { configSchema } from "../../src/config/schema.js";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { processIdentity } from "../../src/tasks/lock.js";
import { writeJson } from "../../src/storage/files.js";
import {
  acquireSessionOperation,
  releaseSessionOperation,
} from "../../src/sessions/operation.js";
import { readSessionState } from "../../src/sessions/state.js";
import { stopSession, readStopIntent } from "../../src/sessions/stop.js";
import { recoverSession } from "../../src/sessions/recovery.js";
import { sessionWorkerPaths } from "../../src/sessions/worker-api.js";
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "session-recover-"));
  try {
    await run(await setup(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function setup(home: string) {
  const cwd = join(home, "project");
  await mkdir(cwd);
  const id = randomUUID();
  const created = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
    taskId: id,
    environmentId: id,
  });
  const session = await bindNativeSession(
    home,
    created.id,
    { cwd: created.cwd, projectId: created.projectId, agent: created.agent },
    "native-original",
  );
  await saveTask(home, {
    id,
    projectId: "test",
    projectRoot: cwd,
    terminalSessionId: session.id,
    containerId: "main",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "prepared",
    prompt: "test",
    round: 0,
    checks: [],
    warnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let running = false;
  const docker = {
    listContainers: async () => [{ Id: "main" }, { Id: "service" }],
    getContainer: () => ({
      inspect: async () => ({
        Config: { Labels: { "relay-sandbox.task": id } },
        State: { Running: running },
      }),
    }),
  } as unknown as Docker;
  const resumeTask = vi.fn(async () => {
    const task = await getTask(home, id);
    task.state = "prepared";
    await saveTask(home, task);
    return task;
  });
  const ensureReady = vi.fn(async () => ({ workerPid: process.pid }));
  const stopTask = vi.fn(async () => {
    const task = await getTask(home, id);
    task.state = "stopped";
    await saveTask(home, task);
    return task;
  });
  return {
    home,
    session,
    docker,
    resumeTask,
    ensureReady,
    stopTask,
    setRunning: (value: boolean) => {
      running = value;
    },
  };
}
// 原生输入也必须受停止意图控制，不能只在网页按钮禁用输入。
test("显式停止先阻断输入，再等待旧开发归还租约并保留现场", async () =>
  fixture(async (f) => {
    const lease = await acquireSessionOperation(
      f.home,
      f.session.id,
      "development",
    );
    const finish = vi.fn(async () => ({}));
    await stopSession({
      ...f,
      driver: {
        stop: async () => {
          await expect(
            acquireSessionOperation(f.home, f.session.id, "development"),
          ).rejects.toThrow("停止");
          await releaseSessionOperation(f.home, f.session.id, lease);
        },
      },
      audit: { finish },
    });
    expect(finish).toHaveBeenCalledOnce();
    expect(f.stopTask).toHaveBeenCalledOnce();
    expect((await readSessionState(f.home, f.session.id)).phase).toBe(
      "interrupted",
    );
    expect(await readStopIntent(f.home, f.session.id)).toBeUndefined();
    await expect(
      readFile(join(f.home, "sessions", f.session.id, "session.json"), "utf8"),
    ).resolves.toContain("native-original");
  }));
test("停止失败保留意图与诊断，不再接受输入", async () =>
  fixture(async (f) => {
    await expect(
      stopSession({
        ...f,
        driver: {
          stop: async () => {
            throw new Error("停止失败");
          },
        },
        audit: { finish: async () => ({}) },
      }),
    ).rejects.toThrow("停止失败");
    expect(await readStopIntent(f.home, f.session.id)).toBeDefined();
    await expect(
      acquireSessionOperation(f.home, f.session.id, "development"),
    ).rejects.toThrow("停止");
    expect(
      await readFile(
        join(f.home, "sessions", f.session.id, "stop-error.json"),
        "utf8",
      ),
    ).toContain("停止失败");
  }));
test("活worker锁与运行容器均阻止恢复，不抢占活进程", async () =>
  fixture(async (f) => {
    const path = sessionWorkerPaths(f.home, f.session.id).lock;
    await writeJson(path, {
      token: randomUUID(),
      pid: process.pid,
      identity: await processIdentity(process.pid),
    });
    await expect(recoverSession(f)).rejects.toThrow("仍存活");
    expect(f.resumeTask).not.toHaveBeenCalled();
    await writeJson(path, {
      token: randomUUID(),
      pid: 99999999,
      identity: "dead",
    });
    f.setRunning(true);
    await expect(recoverSession(f)).rejects.toThrow("仍有写入者");
    expect(await readFile(path, "utf8")).toContain("dead");
  }));
test("确认死亡和写入者停止后清理自身锁并复用原生身份，不重放模型输入", async () =>
  fixture(async (f) => {
    const path = sessionWorkerPaths(f.home, f.session.id).lock;
    await writeJson(path, {
      token: randomUUID(),
      pid: 99999999,
      identity: "dead",
    });
    await writeJson(join(f.home, "sessions", f.session.id, "state.json"), {
      evidenceVersion: 2,
      reviewedVersion: 2,
      phase: "busy",
      revision: 2,
    });
    const result = await recoverSession(f);
    expect(result.session.nativeSessionId).toBe("native-original");
    expect(result.session.id).toBe(f.session.id);
    expect(f.resumeTask).toHaveBeenCalledOnce();
    expect(f.ensureReady).toHaveBeenCalledOnce();
    expect((await readSessionState(f.home, f.session.id)).phase).toBe("idle");
    const recoveredState = await readSessionState(f.home, f.session.id);
    expect(recoveredState.evidenceVersion).toBe(3);
    expect(recoveredState.reviewedVersion).toBe(2);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  }));
import {
  assertRecoveryAdmission,
  recoveryIntentPath,
} from "../../src/sessions/stop-intent.js";
// 同PID不是授权；worker在锁发布前后检查，避免恢复窗口中启动新driver。
test("恢复令牌阻断其他worker和操作，仅授权本次prepare", async () =>
  fixture(async (f) => {
    const token = randomUUID();
    await writeJson(recoveryIntentPath(f.home, f.session.id), {
      token,
      pid: process.pid,
      identity: await processIdentity(process.pid),
    });
    await expect(assertRecoveryAdmission(f.home, f.session.id)).rejects.toThrow(
      "恢复",
    );
    await expect(
      acquireSessionOperation(f.home, f.session.id, "prepare", {
        recoveryToken: randomUUID(),
      }),
    ).rejects.toThrow("恢复");
    await expect(
      acquireSessionOperation(f.home, f.session.id, "development", {
        recoveryToken: token,
      }),
    ).rejects.toThrow("恢复");
    const lease = await acquireSessionOperation(
      f.home,
      f.session.id,
      "prepare",
      { recoveryToken: token },
    );
    await releaseSessionOperation(f.home, f.session.id, lease);
  }));

test("审查忙碌拒绝停止不遗留intent，原操作结束后仍可开发", async () =>
  fixture(async (f) => {
    const lease = await acquireSessionOperation(f.home, f.session.id, "review");
    const stop = vi.fn(async () => {});
    try {
      await expect(
        stopSession({
          ...f,
          driver: { stop },
          audit: { finish: async () => ({}) },
        }),
      ).rejects.toThrow("其他操作");
      expect(stop).not.toHaveBeenCalled();
      expect(await readStopIntent(f.home, f.session.id)).toBeUndefined();
    } finally {
      await releaseSessionOperation(f.home, f.session.id, lease);
    }
    const development = await acquireSessionOperation(
      f.home,
      f.session.id,
      "development",
    );
    await releaseSessionOperation(f.home, f.session.id, development);
  }));

// 后端已经死亡时，停止不能再依赖失效CLI；必须先确认归属写入者全部停止。
test.each([true, false])(
  "故障收尾只有确认写入者停止才释放自身租约 confirmed=%s",
  async (confirmed) =>
    fixture(async (f) => {
      const lease = await acquireSessionOperation(
        f.home,
        f.session.id,
        "development",
      );
      const stop = vi.fn(async () => {
        throw new Error("backend dead");
      });
      const settled = vi.fn(async () => {
        expect(f.stopTask).toHaveBeenCalledOnce();
        await releaseSessionOperation(f.home, f.session.id, lease);
      });
      if (!confirmed)
        f.stopTask.mockImplementationOnce(async () => {
          throw new Error("writer still running");
        });
      const operation = stopSession({
        ...f,
        driver: { stop },
        audit: { finish: async () => ({}) },
        failedBackend: { afterWritersStopped: settled },
      });
      if (confirmed) {
        await operation;
        expect(settled).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toThrow("writer still running");
        expect(settled).not.toHaveBeenCalled();
        await releaseSessionOperation(f.home, f.session.id, lease);
      }
      expect(stop).not.toHaveBeenCalled();
    }),
);

// 永悬的死后端轮次不阻塞已确认停止的后台退出，清理错误仍保留。
test("故障worker经公开stop结束，失效驱动清理错误公开且不挂住", async () =>
  fixture(async (f) => {
    const { startSessionWorker } = await import("../../src/sessions/worker.js");
    const { requestSessionWorker } =
      await import("../../src/sessions/worker-api.js");
    let controls!: import("../../src/sessions/worker.js").NativeWorkerControls;
    const worker = await startSessionWorker({
      home: f.home,
      id: f.session.id,
      driverFactory: async (value) => {
        controls = value;
        return {
          submit: () => new Promise<void>(() => {}),
          stop: async () => {
            await stopSession({
              ...f,
              driver: {
                stop: async () => {
                  throw new Error("dead driver stop");
                },
              },
              failedBackend: {
                afterWritersStopped: controls.settleFailedOperation,
              },
              audit: { finish: async () => ({}) },
            });
          },
          close: async () => {
            throw new Error("dead driver cleanup");
          },
        };
      },
    });
    try {
      await requestSessionWorker(f.home, f.session.id, {
        type: "submit",
        prompt: "pending",
      });
      await controls.fail(new Error("backend exited"));
      await expect(
        requestSessionWorker(f.home, f.session.id, { type: "stop" }),
      ).resolves.toMatchObject({ stopped: true });
      await expect(worker.completion).rejects.toThrow("dead driver cleanup");
      expect(f.stopTask).toHaveBeenCalledOnce();
      await expect(
        requestSessionWorker(f.home, f.session.id, { type: "status" }),
      ).rejects.toBeDefined();
      expect(
        await readFile(
          sessionWorkerPaths(f.home, f.session.id).diagnostic,
          "utf8",
        ),
      ).toContain("dead driver cleanup");
    } finally {
      await worker.close().catch(() => {});
    }
  }));

// 错误示范：容器已恢复不代表原生历史可用，不能提前写成功状态。
test("容器恢复后后台初始化失败仍中断，协调锁先释放且不重放输入", async () =>
  fixture(async (f) => {
    f.ensureReady.mockImplementationOnce(async () => {
      await expect(
        readFile(recoveryIntentPath(f.home, f.session.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readSessionState(f.home, f.session.id)).phase).toBe(
        "interrupted",
      );
      throw new Error("原生历史缺失");
    });
    await expect(recoverSession(f)).rejects.toThrow("原生历史缺失");
    expect(f.resumeTask).toHaveBeenCalledOnce();
    expect(f.ensureReady).toHaveBeenCalledWith(f.home, f.session);
    expect((await readSessionState(f.home, f.session.id)).phase).toBe(
      "interrupted",
    );
    expect(
      await readFile(
        join(f.home, "sessions", f.session.id, "session.json"),
        "utf8",
      ),
    ).toContain("native-original");
  }));

test("缺失既有原生身份时拒绝恢复，不创建新上下文", async () =>
  fixture(async (f) => {
    const withoutNative = { ...f.session };
    delete withoutNative.nativeSessionId;
    await writeJson(
      join(f.home, "sessions", f.session.id, "session.json"),
      withoutNative,
    );
    await expect(
      recoverSession({ ...f, session: withoutNative }),
    ).rejects.toThrow("原生会话");
    expect(f.resumeTask).not.toHaveBeenCalled();
    expect(f.ensureReady).not.toHaveBeenCalled();
  }));

// 就绪只通过后台状态检查，不允许用 prompt 探活或改写既有原生 ID。
test("恢复就绪依赖真实后台回执并校验原生身份", async () =>
  fixture(async (f) => {
    const { ensureSessionReady } =
      await import("../../src/sessions/readiness.js");
    const dispatch = vi.fn(async () => ({ workerPid: process.pid }));
    await expect(
      ensureSessionReady(f.home, f.session, dispatch),
    ).resolves.toEqual({ workerPid: process.pid });
    await expect(
      ensureSessionReady(f.home, f.session, async () => ({
        workerPid: process.pid,
        failure: "request failed",
        lastTurnFailure: "request failed",
      })),
    ).resolves.toMatchObject({ lastTurnFailure: "request failed" });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(f.home, f.session.id);
    await expect(
      ensureSessionReady(f.home, f.session, async () => ({
        backendFailure: "history missing",
      })),
    ).rejects.toThrow("history missing");
    await expect(
      ensureSessionReady(f.home, f.session, async () => ({})),
    ).rejects.toThrow("进程身份");
    await writeJson(join(f.home, "sessions", f.session.id, "session.json"), {
      ...f.session,
      nativeSessionId: "replacement",
    });
    await expect(
      ensureSessionReady(f.home, f.session, dispatch),
    ).rejects.toThrow("身份发生变化");
  }));
