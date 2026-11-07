import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { startSessionAudit } from "../../src/sessions/audit.js";
import { writeJson, readJson } from "../../src/storage/files.js";
import { configSchema } from "../../src/config/schema.js";
import type { DevelopmentSession } from "../../src/sessions/schema.js";
import type { Task } from "../../src/tasks/types.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "session-audit-"));
  homes.push(home);
  const session: DevelopmentSession = {
    version: 2,
    kind: "development",
    id: randomUUID(),
    taskId: randomUUID(),
    projectId: "test",
    cwd: "/test",
    agent: "codex",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const task: Task = {
    id: session.taskId!,
    projectId: "test",
    projectRoot: "/test",
    terminalSessionId: session.id,
    containerId: "test-container",
    environmentReady: true,
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "prepared",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    round: 0,
    checks: [],
    warnings: [],
  };
  await writeJson(join(home, "tasks", task.id, "task.json"), task);
  return { home, session, task };
}
it("重复连接只启动一次，观察快照不结束采集，显式 finish 幂等", async () => {
  const f = await fixture();
  const finish = vi.fn(async () => ({
    coverage: "partial" as const,
    events: [],
    gaps: ["缺口 key-abc"],
    warnings: ["不能判断安全"],
  }));
  const collect = vi.fn(async () => ({
    finish,
    snapshot: async () => ({
      coverage: "partial" as const,
      events: [],
      gaps: ["采集覆盖有限"],
      warnings: [],
    }),
  }));
  const monitor = vi.fn(async () => {});
  const [a, b] = await Promise.all([
    startSessionAudit(f.home, f.session, f.task, ["key-abc"], {
      collect,
      monitor,
    }),
    // 两个连接使用同一受信配置，文件校验完成顺序不决定脱敏输入。
    startSessionAudit(f.home, f.session, f.task, ["key-abc"], { collect, monitor }),
  ]);
  expect(a).toBe(b);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(monitor).toHaveBeenCalledTimes(1);
  expect((await a.snapshot()).coverage).toBe("partial");
  expect(finish).not.toHaveBeenCalled();
  const reports = await Promise.all([a.finish(), b.finish()]);
  expect(reports[0]).toEqual(reports[1]);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(reports[0].gaps).toEqual(["缺口 [已脱敏]"]);
  const index = await readJson<{ status: string; evidenceVersion: number }>(
    join(f.home, "tasks", f.task.id, "session-evidence.json"),
  );
  expect(index.status).toBe("finished");
  expect(index.evidenceVersion).toBe(0);
  expect(
    (await stat(join(f.home, "tasks", f.task.id, "audit.json"))).mode & 0o777,
  ).toBe(0o600);
});
it("采集不可用保留覆盖缺口，拒绝跨任务证据路径", async () => {
  const f = await fixture();
  const collect = vi.fn(async () => ({
    finish: async () => ({
      coverage: "unavailable" as const,
      gaps: ["无内核权限"],
      events: [],
      warnings: ["不能确认"],
    }),
  }));
  const audit = await startSessionAudit(f.home, f.session, f.task, [], {
    collect,
    monitor: async () => {},
  });
  expect((await audit.snapshot()).coverage).toBe("unavailable");
  expect((await audit.finish()).coverage).toBe("unavailable");
  await expect(
    startSessionAudit(f.home, { ...f.session, id: randomUUID() }, f.task),
  ).rejects.toThrow("归属");
});
