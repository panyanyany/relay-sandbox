import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import {
  acquireSessionOperation,
  releaseSessionOperation,
  readSessionOperation,
  withSessionOperation,
  SessionBusyError,
} from "../../src/sessions/operation.js";
import {
  readSessionState,
  updateSessionState,
} from "../../src/sessions/state.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 合成目录验证竞争和版本，不调用模型或用户容器。
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-operation-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const home = join(root, "state");
  const session = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
  });
  return { home, id: session.id };
}
test("并发开发和审查只有一个准入，失败者不能释放已有租约", async () => {
  const { home, id } = await fixture();
  const results = await Promise.allSettled([
    acquireSessionOperation(home, id, "development"),
    acquireSessionOperation(home, id, "review"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
    SessionBusyError,
  );
  const lease = await readSessionOperation(home, id);
  expect(lease).toBeDefined();
  await expect(
    releaseSessionOperation(home, id, { ...lease!, token: "bad" }),
  ).rejects.toThrow(/租约/);
  expect((await readSessionOperation(home, id))?.token).toBe(lease!.token);
  await releaseSessionOperation(home, id, lease!);
});
test("异常释放并推进证据版本，旧审查不能覆盖新开发", async () => {
  const { home, id } = await fixture();
  await expect(
    withSessionOperation(home, id, "development", async () => {
      throw new Error("synthetic failure");
    }),
  ).rejects.toThrow("synthetic failure");
  expect(await readSessionOperation(home, id)).toBeUndefined();
  expect(await readSessionState(home, id)).toMatchObject({
    phase: "idle",
    evidenceVersion: 1,
  });
  await withSessionOperation(home, id, "review", async (lease) => {
    await updateSessionState(home, id, lease, { reviewedVersion: 1 });
  });
  await withSessionOperation(home, id, "development", async (lease) => {
    expect(await readSessionState(home, id)).toMatchObject({
      phase: "busy",
      evidenceVersion: 2,
      reviewedVersion: 1,
    });
    await expect(
      updateSessionState(home, id, lease, { reviewedVersion: 2 }),
    ).rejects.toThrow(/审查/);
  });
});
test("遗留锁不自动抢占，过期租约不能修改状态", async () => {
  const { home, id } = await fixture();
  const lease = await acquireSessionOperation(home, id, "stop");
  await expect(
    acquireSessionOperation(home, id, "review"),
  ).rejects.toBeInstanceOf(SessionBusyError);
  await releaseSessionOperation(home, id, lease);
  await expect(
    updateSessionState(home, id, lease, { phase: "interrupted" }),
  ).rejects.toThrow(/租约/);
});

// 错误示范：状态损坏仍返回 idle 会让第二轮在未知环境继续执行。
test("状态发布失败安全释放自身锁，收尾失败则保留故障锁", async () => {
  const { home, id } = await fixture();
  const path = join(home, "sessions", id, "state.json");
  await writeFile(path, "invalid json");
  await expect(
    acquireSessionOperation(home, id, "development"),
  ).rejects.toThrow();
  expect(await readSessionOperation(home, id)).toBeUndefined();
  await rm(path);
  const lease = await acquireSessionOperation(home, id, "development");
  await writeFile(path, "invalid json");
  await expect(releaseSessionOperation(home, id, lease)).rejects.toThrow();
  expect((await readSessionOperation(home, id))?.token).toBe(lease.token);
});
test("审查不能把旧版本标为新版本已审，中断必须经恢复处理", async () => {
  const { home, id } = await fixture();
  await withSessionOperation(home, id, "development", async () => {});
  await withSessionOperation(home, id, "development", async () => {});
  await withSessionOperation(home, id, "review", async (lease) => {
    await expect(
      updateSessionState(home, id, lease, { reviewedVersion: 1 }),
    ).rejects.toThrow(/证据版本/);
    await updateSessionState(home, id, lease, { phase: "interrupted" });
  });
  await expect(
    acquireSessionOperation(home, id, "development"),
  ).rejects.toThrow(/中断/);
  expect((await readSessionState(home, id)).phase).toBe("interrupted");
  await withSessionOperation(home, id, "prepare", async (lease) => {
    await updateSessionState(home, id, lease, { phase: "idle" });
  });
  await withSessionOperation(home, id, "development", async (lease) => {
    await expect(
      updateSessionState(home, id, lease, { phase: "idle" }),
    ).rejects.toThrow(/恢复或停止/);
  });
  expect((await readSessionState(home, id)).phase).toBe("idle");
});

// 固定材料补审无需重启崩溃环境，也不能顺带把中断标记清除。
test("中断会话允许独占补审，但保留中断并拒绝新开发", async () => {
  const { home, id } = await fixture();
  await withSessionOperation(home, id, "development", async (lease) => {
    await updateSessionState(home, id, lease, { phase: "interrupted" });
  });
  await withSessionOperation(home, id, "review", async (lease) => {
    expect((await readSessionState(home, id)).phase).toBe("interrupted");
    await updateSessionState(home, id, lease, { reviewedVersion: 1 });
    await expect(
      acquireSessionOperation(home, id, "development"),
    ).rejects.toThrow();
  });
  expect(await readSessionState(home, id)).toMatchObject({
    phase: "interrupted",
    reviewedVersion: 1,
  });
  await expect(
    acquireSessionOperation(home, id, "development"),
  ).rejects.toThrow(/中断/);
});
