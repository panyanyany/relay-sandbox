import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  initializeRelay,
  importRelayConfiguration,
} from "../../src/config/relay-initialize.js";
import {
  resolveProject,
  registerProject,
  projectMetadata,
} from "../../src/projects/registry.js";
import { relayConfiguration } from "../../src/config/relay-setup.js";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getImage: () => ({ inspect }) }),
}));
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-init-"));
  roots.push(root);
  const project = join(root, "project"),
    home = join(root, "state");
  await mkdir(project);
  inspect.mockResolvedValue({ Id: `sha256:${"a".repeat(64)}` });
  return {
    home,
    project,
    input: {
      project: "demo",
      projectPath: project,
      confirmProject: true,
      mode: "file" as const,
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("首次初始化要求目录授权，已注册标识不能重定向", async () => {
  const { home, project, input } = await fixture();
  await expect(
    initializeRelay(home, { ...input, confirmProject: false }),
  ).rejects.toThrow("明确授权");
  await expect(resolveProject(home, "demo")).rejects.toThrow();
  const result = await initializeRelay(home, input);
  expect(result).toHaveProperty("file");
  expect(await resolveProject(home, "demo")).toBe(project);
  const other = join(home, "other");
  await mkdir(other);
  await expect(
    initializeRelay(home, { ...input, projectPath: other }),
  ).rejects.toThrow("其他目录");
});
test("私有模板重复准备不覆盖，导入转存密钥并清空模板，保留项目选项", async () => {
  const { home, project, input } = await fixture();
  await writeFile(
    join(project, "relay-sandbox.yaml"),
    "# 保留注释\ndelivery:\n  aiReview: false\n",
  );
  const result = await initializeRelay(home, input);
  if (!("file" in result)) throw Error("缺少模板");
  expect((await stat(result.file)).mode & 0o777).toBe(0o600);
  const settings = {
    metadata: parse(await readFile(result.file, "utf8")).metadata,
    agent: "claude-code",
    endpoint: "https://example.test",
    model: "test",
    apiKey: "synthetic-secret-for-import",
  };
  await writeFile(result.file, stringify(settings));
  await initializeRelay(home, input);
  expect(parse(await readFile(result.file, "utf8"))).toEqual(settings);
  const imported = await importRelayConfiguration(home, "demo");
  expect(imported.check.ready).toBe(true);
  expect(JSON.stringify(imported)).not.toContain(settings.apiKey);
  expect(parse(await readFile(result.file, "utf8")).apiKey).toBe("");
  const config = await relayConfiguration(home, "demo");
  expect(config.credential.source).toBe("private_file");
  const text = await readFile(join(project, "relay-sandbox.yaml"), "utf8");
  expect(text).toContain("保留注释");
  expect(parse(text).delivery.aiReview).toBe(false);
});
test("无效模板不泄露内容且保留输入，拒绝链接与越界标识", async () => {
  const { home, input } = await fixture();
  const result = await initializeRelay(home, input);
  if (!("file" in result)) throw Error("模板");
  const invalid = "apiKey: [sensitive-unfinished";
  await writeFile(result.file, invalid);
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow(
    "不回显内容",
  );
  expect(await readFile(result.file, "utf8")).toBe(invalid);
  await rm(result.file);
  const target = join(home, "target");
  await writeFile(target, "private");
  await symlink(target, result.file);
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow();
  await expect(importRelayConfiguration(home, "../target")).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("private");
});
test("对话模式缺少信息不注册项目，完整信息返回隐藏录入下一步且不联网", async () => {
  const { home, input } = await fixture();
  await expect(
    initializeRelay(home, { ...input, mode: "conversation" }),
  ).rejects.toThrow();
  await expect(resolveProject(home, "demo")).rejects.toThrow();
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await initializeRelay(home, {
    ...input,
    mode: "conversation",
    endpoint: "https://example.test",
    model: "test",
  });
  expect(result).toHaveProperty(
    "credential.command",
    expect.stringContaining("credential-set"),
  );
  expect(result).toHaveProperty("agent", "claude-code");
  expect(fetch).not.toHaveBeenCalled();
});

// 固定时间验证元数据语义，避免把重配时间错误记录为最初创建时间。
test("注册记录创建与更新时间，旧文件保持兼容且不伪造历史", async () => {
  const { home, project } = await fixture();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await registerProject(home, "demo", project);
    const first = await projectMetadata(home, "demo");
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    await registerProject(home, "demo", project);
    const next = await projectMetadata(home, "demo");
    expect(next).toEqual({ ...first, updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(first.createdAt).toBe("2026-01-01T00:00:00.000Z");
    await writeFile(
      join(home, "projects", "legacy.json"),
      JSON.stringify({ root: project }),
    );
    expect(await projectMetadata(home, "legacy")).toEqual({
      projectId: "legacy",
      root: project,
      createdAt: null,
      updatedAt: null,
    });
    expect(await resolveProject(home, "legacy")).toBe(project);
    await registerProject(home, "legacy", project);
    expect((await projectMetadata(home, "legacy")).createdAt).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
test("模板归属不一致时不配置、不转存密钥", async () => {
  const { home, input } = await fixture();
  const result = await initializeRelay(home, input);
  if (!("file" in result)) throw Error("模板");
  const value = parse(await readFile(result.file, "utf8"));
  Object.assign(value, {
    endpoint: "https://example.test",
    model: "test",
    apiKey: "fixture-key",
  });
  value.metadata.root = "/another-project";
  await writeFile(result.file, stringify(value));
  await expect(importRelayConfiguration(home, "demo")).rejects.toThrow(
    "不匹配",
  );
  expect(parse(await readFile(result.file, "utf8"))).toEqual(value);
  expect((await relayConfiguration(home, "demo")).configured).toBe(false);
});
