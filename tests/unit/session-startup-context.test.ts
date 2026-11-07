import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerProject } from "../../src/projects/registry.js";
import { openStartupContext } from "../../src/sessions/startup-context.js";

let home: string, cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "startup-context-"));
  cwd = join(home, "project");
  await mkdir(cwd);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
// 只读启动不准备任务、不读取凭据，也不创建可被恢复的正式会话。
async function configure() {
  await registerProject(home, "demo", cwd);
  await mkdir(join(home, "profiles"), { recursive: true });
  await writeFile(
    join(home, "profiles", "relay-default.yaml"),
    [
      "endpoint: https://example.test",
      "model: test",
      "apiKeyEnv: STARTUP_KEY",
      "protocol: responses",
      `image: image@sha256:${"a".repeat(64)}`,
      `networkImage: network@sha256:${"b".repeat(64)}`,
    ].join("\n"),
  );
}
test("打开只读启动上下文没有正式会话、任务或临时目录副作用", async () => {
  await configure();
  const entries = await readdir(home);
  const context = await openStartupContext(home, { cwd });
  expect(context).toMatchObject({ projectId: "demo", cwd, agent: "codex" });
  expect(await readdir(home)).toEqual(entries);
});
test("未授权目录及缺模型档案明确失败，不能借已有任务配置", async () => {
  await expect(openStartupContext(home, { cwd })).rejects.toThrow("初始化");
  await registerProject(home, "demo", cwd);
  await expect(openStartupContext(home, { cwd })).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readdir(home)).not.toContain("sessions");
});
test("启动复用真实根匹配和配置校验，拒绝非法Agent", async () => {
  await configure();
  const nested = join(cwd, "nested");
  await mkdir(nested);
  const alias = join(home, "alias");
  await symlink(nested, alias);
  expect((await openStartupContext(home, { cwd: alias })).cwd).toBe(cwd);
  await writeFile(
    join(cwd, "relay-sandbox.yaml"),
    "developmentAgent:\n  type: invalid\n",
  );
  await expect(openStartupContext(home, { cwd })).rejects.toThrow();
});
test("启动资源与诊断归属独立", async () => {
  await configure();
  const first = await openStartupContext(home, { cwd });
  const second = await openStartupContext(home, { cwd });
  const resource = {
    kind: "connection" as const,
    id: "synthetic",
    close: vi.fn(),
  };
  first.registerResource(resource);
  expect(first.resources()).toEqual([resource]);
  expect(second.resources()).toEqual([]);
  expect(first.diagnosticDirectory).toBe(
    join(home, "startups", first.startupId),
  );
  expect(first.diagnosticDirectory).not.toContain("environments");
  expect(resource.close).not.toHaveBeenCalled();
});
