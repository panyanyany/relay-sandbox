import { mkdtemp, mkdir, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { registerProject } from "../../src/projects/registry.js";
import { openDevelopmentSession } from "../../src/sessions/environment.js";
import {
  openSession,
  sessionPath,
  bindNativeSession,
} from "../../src/terminal/session.js";

// 旧宿主历史仍可读取，不能把协调器线程ID迁成沙箱开发线程。
test("旧版宿主元数据保留，但新版直连明确拒绝续接旧线程", async () => {
  const home = await mkdtemp(join(tmpdir(), "terminal-legacy-"));
  try {
    const cwd = join(home, "project");
    await mkdir(cwd);
    await registerProject(home, "test", cwd);
    const legacy = await openSession(home, cwd);
    const before = await readFile(sessionPath(home, legacy.id), "utf8");
    await expect(
      openDevelopmentSession(home, { cwd, sessionId: legacy.id }),
    ).rejects.toThrow();
    expect(await readFile(sessionPath(home, legacy.id), "utf8")).toBe(before);
    expect((await openSession(home, cwd, legacy.id)).id).toBe(legacy.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("新终端固定开发Agent与私有元数据，拒绝跨项目续接", async () => {
  const home = await mkdtemp(join(tmpdir(), "terminal-direct-"));
  try {
    const cwd = join(home, "project"),
      other = join(home, "other");
    await mkdir(cwd);
    await mkdir(other);
    await registerProject(home, "test", cwd);
    await registerProject(home, "other", other);
    const session = await openDevelopmentSession(home, { cwd });
    const bound = await bindNativeSession(
      home,
      session.id,
      { cwd, projectId: "test", agent: session.agent },
      "native-development",
    );
    expect(bound.kind).toBe("development");
    expect(bound.version).toBe(2);
    expect((await stat(sessionPath(home, session.id))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      (await openDevelopmentSession(home, { cwd, sessionId: session.id }))
        .nativeSessionId,
    ).toBe("native-development");
    await expect(
      openDevelopmentSession(home, { cwd: other, sessionId: session.id }),
    ).rejects.toThrow("不一致");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
