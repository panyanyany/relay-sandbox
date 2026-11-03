import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import {
  initializeRelay,
  importRelayConfiguration,
} from "../../src/config/relay-initialize.js";
import {
  configureRelay,
  relayConfiguration,
} from "../../src/config/relay-setup.js";
import { loadProfile } from "../../src/config/load.js";
import {
  registerProject,
  registeredProject,
} from "../../src/projects/registry.js";
import * as credentials from "../../src/config/credentials.js";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getImage: () => ({ inspect }) }),
}));
const roots: string[] = [];
const settings = {
  project: "demo",
  agent: "opencode" as const,
  endpoint: "https://example.test/v1",
  model: "fixture",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-setup-regression-"));
  roots.push(root);
  const home = join(root, "state"),
    project = join(root, "project");
  await mkdir(project);
  inspect.mockResolvedValue({ Id: `sha256:${"a".repeat(64)}` });
  const input = {
    project: "demo",
    projectPath: project,
    confirmProject: true,
    mode: "file" as const,
  };
  const prepared = await initializeRelay(home, input);
  if (!("file" in prepared)) throw Error("模板缺失");
  return { home, project, input, file: prepared.file };
}
async function fill(file: string, key = "synthetic-regression-key") {
  const value = parse(await readFile(file, "utf8"));
  Object.assign(value, {
    agent: settings.agent,
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey: key,
  });
  await writeFile(file, stringify(value));
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// SETUP-001：不能只测试抛异常，警告同样可能绕过脱敏路径。
test("未知YAML标签不触发进程警告，不回显密钥且保留模板", async () => {
  const { home, file } = await fixture();
  await fill(file);
  const original = (await readFile(file, "utf8")).replace(
    "apiKey: synthetic-regression-key",
    "apiKey: !unknown synthetic-regression-key",
  );
  await writeFile(file, original);
  const warning = vi.spyOn(process, "emitWarning");
  const stderr = vi.spyOn(process.stderr, "write");
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow(
    "不回显内容",
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(warning).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe(original);
});
test("新项目继承共享凭据值但独立存储，修改B不影响A和原档案", async () => {
  const { home, project } = await fixture();
  const shared = {
    endpoint: settings.endpoint,
    model: settings.model,
    protocol: "openai-compatible",
    apiKeyEnv: "RELAY_SHARED_REGRESSION",
    image: `sha256:${"a".repeat(64)}`,
    networkImage: `sha256:${"a".repeat(64)}`,
  };
  await writeFile(
    join(home, "profiles", "relay-default.yaml"),
    stringify(shared),
  );
  vi.stubEnv(shared.apiKeyEnv, "synthetic-shared-value");
  const other = join(project, "other");
  await mkdir(other);
  await registerProject(home, "other", other);
  await configureRelay(home, settings);
  await configureRelay(home, { ...settings, project: "other" });
  const a = await loadProfile(home, "project-demo"),
    b = await loadProfile(home, "project-other");
  expect(new Set([a.apiKeyEnv, b.apiKeyEnv, shared.apiKeyEnv]).size).toBe(3);
  await credentials.saveCredential(home, b.apiKeyEnv, "synthetic-other-value");
  expect((await credentials.readCredential(home, a))?.key).toBe(
    "synthetic-shared-value",
  );
  expect((await credentials.readCredential(home, shared))?.key).toBe(
    "synthetic-shared-value",
  );
  // 已存在的专用档案保持原变量名，避免批量迁移破坏旧环境注入。
  await writeFile(
    join(home, "profiles", "project-demo.yaml"),
    stringify(shared),
  );
  await configureRelay(home, settings);
  expect((await loadProfile(home, "project-demo")).apiKeyEnv).toBe(
    shared.apiKeyEnv,
  );
});
test("旧目录消失不会变成首次注册，原注册记录保持不变", async () => {
  const { home, project, input } = await fixture();
  const before = await registeredProject(home, "demo");
  await rm(project, { recursive: true });
  const other = join(home, "other");
  await mkdir(other);
  await expect(
    initializeRelay(home, { ...input, projectPath: other }),
  ).rejects.toThrow();
  expect(await registeredProject(home, "demo")).toEqual(before);
});
test("模板预填原Agent地址模型，空密钥保留凭据且重复导入可用", async () => {
  const { home, file, input } = await fixture();
  await configureRelay(home, settings);
  const profile = await loadProfile(home, "project-demo");
  await credentials.saveCredential(
    home,
    profile.apiKeyEnv,
    "synthetic-existing-value",
  );
  await rm(file);
  await initializeRelay(home, input);
  const text = await readFile(file, "utf8"),
    value = parse(text);
  expect(value).toMatchObject({
    agent: settings.agent,
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey: "",
  });
  expect(text).toContain("留空保留现有凭据");
  for (let i = 0; i < 2; i++) {
    const imported = await importRelayConfiguration(home, "demo");
    expect(imported.check.ready).toBe(true);
    expect(imported.credentialUpdate.saved).toBe(false);
  }
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    "synthetic-existing-value",
  );
});
test("没有现有凭据时空密钥失败，保持原配置和模板", async () => {
  const { home, file } = await fixture();
  await fill(file, "");
  const before = await readFile(file, "utf8");
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow(
    "没有可用凭据",
  );
  expect((await relayConfiguration(home, "demo")).configured).toBe(false);
  expect(await readFile(file, "utf8")).toBe(before);
});
test("环境变量覆盖新密钥时报告保存与生效状态，默认不联网", async () => {
  const { home, file } = await fixture();
  await configureRelay(home, settings);
  const profile = await loadProfile(home, "project-demo");
  vi.stubEnv(profile.apiKeyEnv, "synthetic-environment-key");
  await fill(file);
  const fetch = vi.spyOn(globalThis, "fetch");
  const imported = await importRelayConfiguration(home, "demo");
  expect(imported.credentialUpdate).toEqual({
    saved: true,
    applied: false,
    effectiveSource: "environment",
    warnings: ["environment_overrides_saved_credential"],
  });
  expect(imported.userAction).toContain("实际仍使用环境注入凭据");
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv(profile.apiKeyEnv, "");
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    "synthetic-regression-key",
  );
});
// SETUP-004：将导入暂停在凭据保存阶段，确认注册、配置、重复导入都不能插入。
test("导入保存及收尾持有同一锁，失败释放锁且模板可重试", async () => {
  const { home, file, project, input } = await fixture();
  await fill(file);
  const original = credentials.saveCredential;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const saving = vi
    .spyOn(credentials, "saveCredential")
    .mockImplementationOnce(async (...args) => {
      enter();
      await gate;
      await original(...args);
    });
  const importing = importRelayConfiguration(home, "demo");
  try {
    await entered;
    for (const operation of [
      () => configureRelay(home, settings),
      () => registerProject(home, "demo", project),
      () => initializeRelay(home, input),
      () => importRelayConfiguration(home, "demo"),
    ])
      await expect(operation()).rejects.toThrow("项目配置正在操作");
    expect(parse(await readFile(file, "utf8")).apiKey).toBe(
      "synthetic-regression-key",
    );
  } finally {
    release();
    await importing;
  }
  saving.mockRejectedValueOnce(new Error("模拟保存失败"));
  await fill(file, "synthetic-retry-key");
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow(
    "模拟保存失败",
  );
  expect(parse(await readFile(file, "utf8")).apiKey).toBe(
    "synthetic-retry-key",
  );
  expect((await importRelayConfiguration(home, "demo")).check.ready).toBe(true);
});
