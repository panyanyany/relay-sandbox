import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createDevelopmentSession,
  readDevelopmentSession,
  bindNativeSession,
  bindDevelopmentEnvironment,
  openSession,
  saveSession,
  sessionPath,
} from "../../src/terminal/session.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 合成项目验证身份边界，不读取用户项目或调用模型。
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-session-store-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const home = join(root, "state");
  const identity = { cwd, projectId: "synthetic", agent: "codex" as const };
  return { root, home, identity };
}
test("开发会话持久化真实目录、关联和私有权限", async () => {
  const { root, home, identity } = await fixture();
  const alias = join(root, "alias");
  await symlink(identity.cwd, alias);
  const session = await createDevelopmentSession(home, {
    ...identity,
    cwd: alias,
    taskId: "a77cfb82-28f8-4bdd-8cb6-472457eb919b",
    environmentId: "environment-test",
  });
  expect(session).toMatchObject({
    version: 2,
    kind: "development",
    ...identity,
  });
  expect(session.nativeSessionId).toBeUndefined();
  expect(await readDevelopmentSession(home, session.id, identity)).toEqual(
    session,
  );
  expect((await stat(sessionPath(home, session.id))).mode & 0o777).toBe(0o600);
  expect((await stat(join(home, "sessions", session.id))).mode & 0o777).toBe(
    0o700,
  );
});
test("恢复拒绝不同目录、项目标识和 Agent", async () => {
  const { root, home, identity } = await fixture();
  const session = await createDevelopmentSession(home, identity);
  const other = join(root, "other");
  await mkdir(other);
  for (const expected of [
    { ...identity, cwd: other },
    { ...identity, projectId: "other" },
    { ...identity, agent: "claude-code" as const },
  ]) {
    await expect(
      readDevelopmentSession(home, session.id, expected),
    ).rejects.toThrow(/不一致/);
  }
});
test("原生身份只能绑定一次，并发竞争不能覆盖", async () => {
  const { home, identity } = await fixture();
  const session = await createDevelopmentSession(home, identity);
  await bindNativeSession(home, session.id, identity, "native-one");
  expect(
    (await bindNativeSession(home, session.id, identity, "native-one"))
      .nativeSessionId,
  ).toBe("native-one");
  await expect(
    bindNativeSession(home, session.id, identity, "native-two"),
  ).rejects.toThrow(/原生会话/);
  expect(
    (await readDevelopmentSession(home, session.id, identity)).nativeSessionId,
  ).toBe("native-one");
  const fresh = await createDevelopmentSession(home, identity);
  const results = await Promise.allSettled([
    bindNativeSession(home, fresh.id, identity, "a"),
    bindNativeSession(home, fresh.id, identity, "b"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
});
test("旧宿主会话继续可读写，但不能当开发原生身份恢复", async () => {
  const { home, identity } = await fixture();
  const legacy = await openSession(home, identity.cwd);
  legacy.nativeId = "host-thread";
  await saveSession(home, legacy);
  expect((await openSession(home, identity.cwd, legacy.id)).nativeId).toBe(
    "host-thread",
  );
  await expect(
    readDevelopmentSession(home, legacy.id, identity),
  ).rejects.toThrow(/旧版宿主/);
  const development = await createDevelopmentSession(home, identity);
  await expect(
    readDevelopmentSession(home, "invalid-id", identity),
  ).rejects.toThrow();
  await expect(
    readDevelopmentSession(home, development.id, {
      ...identity,
      agent: "opencode",
    }),
  ).rejects.toThrow();
});

// 准备任务后绑定环境，不能把同一开发上下文悄悄迁到其他任务。
test("准备后绑定任务和环境，后续不允许替换", async () => {
  const { home, identity } = await fixture();
  const session = await createDevelopmentSession(home, identity);
  const binding = {
    taskId: "a77cfb82-28f8-4bdd-8cb6-472457eb919b",
    environmentId: "environment-test",
  };
  expect(
    await bindDevelopmentEnvironment(home, session.id, identity, binding),
  ).toMatchObject(binding);
  await expect(
    bindDevelopmentEnvironment(home, session.id, identity, binding),
  ).resolves.toMatchObject(binding);
  await expect(
    bindDevelopmentEnvironment(home, session.id, identity, {
      ...binding,
      environmentId: "other",
    }),
  ).rejects.toThrow(/绑定/);
  await expect(
    bindDevelopmentEnvironment(home, session.id, identity, {
      ...binding,
      taskId: "b77cfb82-28f8-4bdd-8cb6-472457eb919b",
    }),
  ).rejects.toThrow(/绑定/);
});
