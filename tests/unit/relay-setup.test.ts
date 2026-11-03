import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRelaySetup } from "../../src/mcp/relay-setup.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { registerProject } from "../../src/projects/registry.js";
import {
  configureRelay,
  relayConfiguration,
  registeredRelayProjects,
} from "../../src/config/relay-setup.js";
import { checkRelayConfiguration } from "../../src/config/relay-check.js";
import {
  readCredential,
  saveCredential,
} from "../../src/config/credentials.js";
import { loadConfig, loadProfile } from "../../src/config/load.js";
import { developmentAdapter } from "../../src/agents/development/adapters.js";
import { createTask } from "../../src/tasks/create.js";
import * as environments from "../../src/environments/acquire.js";
import * as install from "../../src/tasks/environment-install.js";
import * as monitor from "../../src/monitoring/monitor.js";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getImage: () => ({ inspect }) }),
}));
const roots: string[] = [];
const image = `sha256:${"a".repeat(64)}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-setup-"));
  roots.push(root);
  const home = join(root, "state"),
    project = join(root, "project");
  await mkdir(project);
  await registerProject(home, "demo", project);
  inspect.mockResolvedValue({ Id: image });
  return { root, home, project };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const settings = {
  project: "demo",
  agent: "claude-code" as const,
  endpoint: "https://relay.example",
  model: "claude-test",
};

test("首次配置保留中文注释与交付选项，密钥不进项目、档案或查询", async () => {
  const { home, project } = await fixture();
  const path = join(project, "relay-sandbox.yaml");
  await writeFile(
    path,
    "# 原有中文说明\ndelivery:\n  aiReview: false\nproject:\n  exclude: [private/**]\n",
  );
  expect((await relayConfiguration(home, "demo")).configured).toBe(false);
  expect((await registeredRelayProjects(home)).projects).toMatchObject([
    { project: "demo" },
  ]);
  const result = await configureRelay(home, settings);
  expect(result.protocol).toBe("anthropic");
  expect(result.credential.ready).toBe(false);
  expect(result.credential.command).toContain("credential-set");
  const text = await readFile(path, "utf8");
  expect(text).toContain("# 原有中文说明");
  expect(parse(text).delivery.aiReview).toBe(false);
  expect(parse(text).project.exclude).toEqual(["private/**"]);
  const profile = await loadProfile(home, "project-demo");
  await saveCredential(home, profile.apiKeyEnv, "private-test-value");
  expect(
    (await stat(join(home, "credentials", `${profile.apiKeyEnv}.json`))).mode &
      0o777,
  ).toBe(0o600);
  const ready = await relayConfiguration(home, "demo");
  expect(ready.credential).toMatchObject({
    ready: true,
    source: "private_file",
  });
  expect(JSON.stringify(ready)).not.toContain("private-test-value");
  expect(
    await readFile(join(home, "profiles/project-demo.yaml"), "utf8"),
  ).not.toContain("private-test-value");
  expect(
    developmentAdapter("claude-code").launch(
      "test",
      profile,
      (await readCredential(home, profile))!.key,
    ).env,
  ).toMatchObject({
    ANTHROPIC_BASE_URL: settings.endpoint,
    ANTHROPIC_API_KEY: "private-test-value",
  });
});

test("环境变量优先，损坏或链接凭据明确失败且不泄露内容", async () => {
  const { home, root } = await fixture();
  const variable = "RELAY_SETUP_TEST_KEY";
  await saveCredential(home, variable, "file-value");
  vi.stubEnv(variable, "environment-value");
  expect((await readCredential(home, { apiKeyEnv: variable }))?.source).toBe(
    "environment",
  );
  vi.stubEnv(variable, "");
  const file = join(home, "credentials", `${variable}.json`);
  await writeFile(file, "broken private-test-value");
  await expect(readCredential(home, { apiKeyEnv: variable })).rejects.toThrow(
    "不是有效JSON",
  );
  await rm(file);
  await writeFile(join(root, "outside"), "outside");
  await symlink(join(root, "outside"), file);
  await expect(readCredential(home, { apiKeyEnv: variable })).rejects.toThrow();
});

test("每项目独立档案不修改共享档案，拒绝带查询参数和未知项目", async () => {
  const { home } = await fixture();
  await mkdir(join(home, "profiles"), { recursive: true });
  const shared = stringify({
    endpoint: "https://old.example/v1",
    model: "old",
    apiKeyEnv: "SHARED_TEST_KEY",
    protocol: "responses",
    image,
    networkImage: image,
  });
  await writeFile(join(home, "profiles/relay-default.yaml"), shared);
  await configureRelay(home, settings);
  expect(
    await readFile(join(home, "profiles/relay-default.yaml"), "utf8"),
  ).toBe(shared);
  await expect(
    configureRelay(home, {
      ...settings,
      endpoint: "https://relay.example?token=private",
    }),
  ).rejects.toThrow("查询");
  await expect(
    configureRelay(home, { ...settings, project: "unknown" }),
  ).rejects.toThrow();
});

test("默认检查不联网，显式验证使用适配协议且不返回响应正文", async () => {
  const { home } = await fixture();
  await configureRelay(home, settings);
  await saveCredential(
    home,
    (await loadProfile(home, "project-demo")).apiKeyEnv,
    "private-test-value",
  );
  const request = vi
    .fn()
    .mockResolvedValue(new Response("private response", { status: 200 }));
  vi.stubGlobal("fetch", request);
  expect((await checkRelayConfiguration(home, "demo")).ready).toBe(true);
  expect(request).not.toHaveBeenCalled();
  const checked = await checkRelayConfiguration(home, "demo", true);
  expect(request.mock.calls[0]![0]).toBe("https://relay.example/v1/messages");
  expect(checked.connection).toMatchObject({ tested: true, ok: true });
  expect(JSON.stringify(checked)).not.toMatch(
    /private-test-value|private response/,
  );
  request.mockRejectedValueOnce(new Error("network failure"));
  expect((await checkRelayConfiguration(home, "demo", true)).ready).toBe(false);
});

test("创建任务使用本机凭据文件，无需重启或注入环境变量", async () => {
  const { home, project } = await fixture();
  await configureRelay(home, settings);
  await saveCredential(
    home,
    (await loadProfile(home, "project-demo")).apiKeyEnv,
    "private-test-value",
  );
  vi.spyOn(environments, "acquireEnvironment").mockImplementation(
    async (_home, task) => {
      task.containerId = "container";
      return true;
    },
  );
  vi.spyOn(install, "installEnvironment").mockResolvedValue({
    summary: {
      schemaVersion: 1,
      runtimeId: "task",
      containerId: "container",
      role: "main",
      enabled: false,
      traffic: "disabled",
      placements: [],
      gaps: [],
    },
  });
  vi.spyOn(monitor, "startMonitor").mockResolvedValue(undefined);
  const task = await createTask(home, "demo", "test");
  expect(task.containerId).toBe("container");
  expect((await loadConfig(project)).developmentAgent.type).toBe("claude-code");
  expect(JSON.stringify(task)).not.toContain("private-test-value");
});

// 低层非敏感配置入口仍严格拒绝密钥；主动提供的密钥由初始化或专用入口处理。
test("非敏感configure_relay拒绝密钥字段，普通配置与查询可用", async () => {
  const { home } = await fixture();
  const server = new McpServer({ name: "setup", version: "1" });
  registerRelaySetup(server, home);
  const client = new Client({ name: "setup-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const before = await client.callTool({
      name: "get_relay_configuration",
      arguments: {},
    });
    expect(before.content).toMatchObject([
      { text: expect.stringContaining("registrationCommand") },
    ]);
    const rejected = await client.callTool({
      name: "configure_relay",
      arguments: { ...settings, apiKey: "private-test-value" },
    });
    expect(rejected.isError).toBe(true);
    expect((await relayConfiguration(home, "demo")).configured).toBe(false);
    const configured = await client.callTool({
      name: "configure_relay",
      arguments: settings,
    });
    expect(configured.isError).not.toBe(true);
    expect(configured.content).toMatchObject([
      { text: expect.stringContaining("credential-set") },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
