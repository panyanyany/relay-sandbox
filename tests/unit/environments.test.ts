import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import {
  readEnvironment,
  saveEnvironment,
  withEnvironmentLock,
  type ProjectEnvironment,
} from "../../src/environments/store.js";
import {
  claimEnvironment,
  ownsRuntime,
  releaseEnvironment,
} from "../../src/environments/ownership.js";
import { expiredEnvironments } from "../../src/environments/lifecycle.js";
import type { Task } from "../../src/tasks/types.js";
const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-env-unit-"));
  roots.push(home);
  const environment: ProjectEnvironment = {
    version: 1,
    id: "env",
    projectId: "project",
    signature: "test",
    mode: "persistent",
    idleRetentionHours: 1,
    activeTaskId: "first",
    createdAt: new Date().toISOString(),
  };
  await saveEnvironment(home, environment);
  const task = {
    id: "first",
    projectId: "project",
    environmentId: "env",
  } as Task;
  return { home, environment, task };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("默认永久保留，临时和TTL必须显式选择，TTL时间必须有效", () => {
  expect(configSchema.parse({}).environment.mode).toBe("persistent");
  expect(
    configSchema.parse({ environment: { mode: "ephemeral" } }).environment.mode,
  ).toBe("ephemeral");
  expect(() =>
    configSchema.parse({ environment: { mode: "ttl", idleRetentionHours: 0 } }),
  ).toThrow();
});

// 旧任务不能释放新借用者；恢复也不能跨越环境重置或其他任务使用记录。
test("停止释放、同任务恢复与跨任务所有权", async () => {
  const { home, task } = await fixture();
  expect(await ownsRuntime(home, task)).toBe(true);
  await releaseEnvironment(home, task);
  expect(await ownsRuntime(home, task)).toBe(false);
  await claimEnvironment(home, task);
  expect(await ownsRuntime(home, task)).toBe(true);
  await releaseEnvironment(home, task);
  const environment = (await readEnvironment(home, "project"))!;
  environment.activeTaskId = "second";
  await saveEnvironment(home, environment);
  await releaseEnvironment(home, task);
  expect((await readEnvironment(home, "project"))?.activeTaskId).toBe("second");
  await expect(claimEnvironment(home, task)).rejects.toThrow("其他任务");
});

test("永久环境不超时，TTL只回收空闲环境，旧任务兼容原生命周期", async () => {
  const { home, task } = await fixture();
  await releaseEnvironment(home, task);
  const later = Date.now() + 7200000;
  expect(await expiredEnvironments(home, later)).toEqual([]);
  const environment = (await readEnvironment(home, "project"))!;
  environment.mode = "ttl";
  await saveEnvironment(home, environment);
  expect(await expiredEnvironments(home, later)).toEqual(["project"]);
  await claimEnvironment(home, task);
  expect(await expiredEnvironments(home, later)).toEqual([]);
  const legacy = { ...task };
  delete legacy.environmentId;
  expect(await ownsRuntime(home, legacy)).toBe(true);
});

test("并发环境管理明确失败，不覆盖持有者，异常后释放锁", async () => {
  const { home } = await fixture();
  await expect(
    withEnvironmentLock(home, "project", async () => {
      await expect(
        withEnvironmentLock(home, "project", async () => undefined),
      ).rejects.toThrow("正在操作");
      throw new Error("synthetic");
    }),
  ).rejects.toThrow("synthetic");
  await expect(
    withEnvironmentLock(home, "project", async () => "ok"),
  ).resolves.toBe("ok");
});
