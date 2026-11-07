import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import {
  startSessionWorker,
  type NativeWorkerControls,
} from "../../src/sessions/worker.js";
import {
  readSessionState,
  updateSessionState,
} from "../../src/sessions/state.js";
import {
  acquireSessionOperation,
  releaseSessionOperation,
} from "../../src/sessions/operation.js";

// 后端空闲死亡和迟到的轮次完成都不能把故障现场改回 idle。
test.each([false, true])(
  "后端故障持久中断且不抢现有租约 active=%s",
  async (active) => {
    const home = await mkdtemp(join(tmpdir(), "relay-failure-"));
    await mkdir(join(home, "project"));
    const session = await createDevelopmentSession(home, {
      cwd: join(home, "project"),
      projectId: "test",
      agent: "codex",
    });
    let controls!: NativeWorkerControls;
    const worker = await startSessionWorker({
      home,
      id: session.id,
      driverFactory: async (value) => {
        controls = value;
        return { submit: async () => {} };
      },
    });
    try {
      const lease = active
        ? await controls.acquireNativeOperation()
        : await acquireSessionOperation(home, session.id, "review");
      await controls.fail(new Error("container exited 137"));
      await controls.fail(new Error("duplicate vendor exit"));
      if (active) await controls.completeNativeOperation(lease);
      else await releaseSessionOperation(home, session.id, lease);
      expect(await readSessionState(home, session.id)).toMatchObject({
        phase: "interrupted",
        evidenceVersion: active ? 2 : 1,
      });
      await expect(controls.acquireNativeOperation()).rejects.toThrow(/137/);
      await expect(
        acquireSessionOperation(home, session.id, "development"),
      ).rejects.toThrow(/中断/);
      const recovery = await acquireSessionOperation(
        home,
        session.id,
        "prepare",
      );
      await updateSessionState(home, session.id, recovery, {
        phase: "idle",
        invalidateEvidence: true,
      });
      await releaseSessionOperation(home, session.id, recovery);
      expect(await readSessionState(home, session.id)).toMatchObject({
        phase: "idle",
        evidenceVersion: active ? 3 : 2,
      });
    } finally {
      await worker.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  },
);
