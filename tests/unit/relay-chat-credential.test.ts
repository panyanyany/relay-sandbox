import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRelaySetup } from "../../src/mcp/relay-setup.js";
import { loadProfile } from "../../src/config/load.js";
import * as relayCheck from "../../src/config/relay-check.js";
import * as credentials from "../../src/config/credentials.js";
import { relayConfiguration } from "../../src/config/relay-setup.js";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getImage: () => ({ inspect }) }),
}));
const cleanup: (() => Promise<void>)[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-chat-key-"));
  const home = join(root, "state"),
    project = join(root, "project");
  await mkdir(project);
  inspect.mockResolvedValue({ Id: `sha256:${"a".repeat(64)}` });
  const client = new Client({ name: "test", version: "1" }),
    server = new McpServer({ name: "test", version: "1" });
  registerRelaySetup(server, home);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    project: "demo",
    projectPath: project,
    confirmProject: true,
    agent: "claude-code",
    endpoint: "https://example.test",
    model: "fixture",
  };
  return { home, project, input, client };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) await close();
});
// 通过SDK实际调用，验证参数中的密钥可用但不会进入返回结果、档案或进程日志。
test("主动提供密钥可一步初始化并检查，不要求CLI且不联网", async () => {
  const { home, project, input, client } = await fixture();
  const key = "synthetic-chat-initialize-key";
  const fetch = vi.spyOn(globalThis, "fetch"),
    stderr = vi.spyOn(process.stderr, "write"),
    stdout = vi.spyOn(process.stdout, "write");
  const result = await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: key },
  });
  expect(result.isError).not.toBe(true);
  const value = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(value.check.ready).toBe(true);
  expect(value.credentialUpdate).toMatchObject({ saved: true, applied: true });
  expect(value.userAction).not.toContain("录入");
  expect(value.securityNotice).toContain("记录可能保留");
  const profile = await loadProfile(home, "project-demo");
  expect((await credentials.readCredential(home, profile))?.key).toBe(key);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(
    await readFile(join(home, "profiles", "project-demo.yaml"), "utf8"),
  ).not.toContain(key);
  expect(
    await readFile(join(project, "relay-sandbox.yaml"), "utf8"),
  ).not.toContain(key);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(key);
  expect(JSON.stringify(stdout.mock.calls)).not.toContain(key);
  expect(fetch).not.toHaveBeenCalled();
});
test("未提供密钥同时返回隐藏命令和实际可编辑私有模板", async () => {
  const { input, client } = await fixture();
  const result = await client.callTool({
    name: "initialize_relay",
    arguments: input,
  });
  const value = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(value.credential.command).toContain("credential-set");
  expect(value.credentialFile).toBeTruthy();
  const template = parse(await readFile(value.credentialFile, "utf8"));
  expect(template).toMatchObject({
    agent: input.agent,
    endpoint: input.endpoint,
    model: input.model,
    apiKey: "",
  });
  expect(value.userAction).toContain("编辑");
});
test("已配置项目只提供密钥即可完成，无需重输地址和模型；环境覆盖提示保留", async () => {
  const { home, input, client } = await fixture();
  await client.callTool({ name: "initialize_relay", arguments: input });
  const profile = await loadProfile(home, "project-demo");
  vi.stubEnv(profile.apiKeyEnv, "synthetic-environment");
  const result = await client.callTool({
    name: "set_relay_credential",
    arguments: { project: "demo", apiKey: "synthetic-followup-key" },
  });
  expect(result.isError).not.toBe(true);
  const value = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(value.credentialUpdate).toMatchObject({
    saved: true,
    applied: false,
    effectiveSource: "environment",
  });
  expect(value.nextAction).toBe("resolve_credential_override");
  vi.stubEnv(profile.apiKeyEnv, "");
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    "synthetic-followup-key",
  );
  expect((await relayConfiguration(home, "demo")).model).toBe(input.model);
});
test("保存失败的异常链和诊断均脱敏，失败后释放锁可重试", async () => {
  const { home, input, client } = await fixture();
  await client.callTool({ name: "initialize_relay", arguments: input });
  const key = "synthetic-failure-key";
  const save = vi
    .spyOn(credentials, "saveCredential")
    .mockRejectedValueOnce(
      new Error(`保存失败 ${key}`, { cause: new Error(`内部原因 ${key}`) }),
    );
  const failed = await client.callTool({
    name: "set_relay_credential",
    arguments: { project: "demo", apiKey: key },
  });
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain(key);
  expect(JSON.stringify(failed)).toContain("原因");
  save.mockRestore();
  expect(
    (
      await client.callTool({
        name: "set_relay_credential",
        arguments: { project: "demo", apiKey: key },
      })
    ).isError,
  ).not.toBe(true);
  const profile = await loadProfile(home, "project-demo");
  expect((await credentials.readCredential(home, profile))?.key).toBe(key);
});
test("文件模式拒绝聊天密钥且不注册项目，默认文件流程不受影响", async () => {
  const { home, input, client } = await fixture();
  const result = await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, mode: "file", apiKey: "synthetic-rejected-key" },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic-rejected-key");
  await expect(relayConfiguration(home, "demo")).rejects.toThrow();
  const file = await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, mode: "file" },
  });
  expect(file.isError).not.toBe(true);
});

// 错误示范：先JSON序列化再替换密钥，转义字符会漏报，短密钥会破坏字段名。
test.each(['quote"slash\\line\nsecret', "x"])(
  "结构化诊断保持JSON有效并隐藏特殊密钥 %s",
  async (key) => {
    const { input, client } = await fixture();
    await client.callTool({ name: "initialize_relay", arguments: input });
    inspect.mockRejectedValue(new Error(`镜像诊断 ${key}`));
    const result = await client.callTool({
      name: "set_relay_credential",
      arguments: { project: "demo", apiKey: key },
    });
    const value = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(value.credentialUpdate.saved).toBe(true);
    expect(value.check.diagnostics[0].error).not.toContain(key);
    expect(value.check.ready).toBe(false);
  },
);
test("主动新密钥可替换损坏的安全私有文件，但拒绝不安全权限", async () => {
  const { home, input, client } = await fixture();
  await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: "first-fixture" },
  });
  const profile = await loadProfile(home, "project-demo");
  const path = join(home, "credentials", `${profile.apiKeyEnv}.json`);
  await writeFile(path, "broken-json");
  const result = await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: "replacement-fixture" },
  });
  expect(result.isError).not.toBe(true);
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    "replacement-fixture",
  );
  await chmod(path, 0o644);
  const unsafe = await client.callTool({
    name: "set_relay_credential",
    arguments: { project: "demo", apiKey: "unsafe-fixture" },
  });
  expect(unsafe.isError).toBe(true);
});
test("旧模板导入拒绝覆盖新配置，保留待导入密钥", async () => {
  const { home, input, client } = await fixture();
  const first = await client.callTool({
    name: "initialize_relay",
    arguments: input,
  });
  const path = JSON.parse(
    (first.content as { text: string }[])[0]!.text,
  ).credentialFile;
  const doc = parse(await readFile(path, "utf8"));
  doc.apiKey = "pending-fixture";
  await writeFile(path, stringify(doc));
  await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, model: "new-model", apiKey: "current-fixture" },
  });
  const result = await client.callTool({
    name: "import_relay_configuration",
    arguments: { project: "demo" },
  });
  expect(result.isError).toBe(true);
  expect((await relayConfiguration(home, "demo")).model).toBe("new-model");
  expect(parse(await readFile(path, "utf8")).apiKey).toBe("pending-fixture");
});

// 收尾失败不能伪装成未保存；保留原因链供宿主判断下一步。
test("保存后检查抛错仍返回saved及脱敏阶段诊断", async () => {
  const { input, client } = await fixture();
  await client.callTool({ name: "initialize_relay", arguments: input });
  const key = 'post-save-"fixture';
  vi.spyOn(relayCheck, "checkRelayConfiguration").mockRejectedValueOnce(
    new Error(`检查失败 ${key}`, { cause: new Error("根因") }),
  );
  const result = await client.callTool({
    name: "set_relay_credential",
    arguments: { project: "demo", apiKey: key },
  });
  const value = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(value.credentialUpdate.saved).toBe(true);
  expect(value.check.ready).toBe(false);
  expect(value.check.diagnostics[0].stage).toBe("local_check");
  expect(value.check.diagnostics[0].error).toContain("根因");
  expect(value.check.diagnostics[0].error).not.toContain(key);
});
test("协议不匹配在写入凭据前明确报错", async () => {
  const { home, input, client } = await fixture();
  await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: "original-fixture" },
  });
  const path = join(home, "profiles", "project-demo.yaml");
  const profile = parse(await readFile(path, "utf8"));
  profile.protocol = "responses";
  await writeFile(path, stringify(profile));
  const result = await client.callTool({
    name: "set_relay_credential",
    arguments: { project: "demo", apiKey: "replacement-fixture" },
  });
  expect(result.isError).toBe(true);
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    "original-fixture",
  );
});

test("文件导入同样可以替换损坏凭据，导入后清空模板密钥", async () => {
  const { home, input, client } = await fixture();
  await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: "initial-fixture" },
  });
  const prepared = await client.callTool({
    name: "initialize_relay",
    arguments: { project: "demo", mode: "file" },
  });
  const path = JSON.parse(
    (prepared.content as { text: string }[])[0]!.text,
  ).file;
  const doc = parse(await readFile(path, "utf8"));
  doc.apiKey = "file-replacement-fixture";
  await writeFile(path, stringify(doc));
  const profile = await loadProfile(home, "project-demo");
  await writeFile(
    join(home, "credentials", `${profile.apiKeyEnv}.json`),
    "invalid-json",
  );
  const imported = await client.callTool({
    name: "import_relay_configuration",
    arguments: { project: "demo" },
  });
  expect(imported.isError).not.toBe(true);
  expect((await credentials.readCredential(home, profile))?.key).toBe(
    doc.apiKey,
  );
  expect(parse(await readFile(path, "utf8")).apiKey).toBe("");
});

test("模板清理失败保留已保存状态及错误阶段", async () => {
  const { credentialOutcome } =
    await import("../../src/config/relay-outcome.js");
  const { home, input, client } = await fixture();
  await client.callTool({
    name: "initialize_relay",
    arguments: { ...input, apiKey: "cleanup-fixture" },
  });
  const profile = await loadProfile(home, "project-demo");
  const value = await credentialOutcome(
    home,
    "demo",
    true,
    profile.apiKeyEnv,
    "cleanup-fixture",
    async () => {
      throw new Error("清理失败 cleanup-fixture");
    },
  );
  expect(value.credentialUpdate.saved).toBe(true);
  expect(value.check.ready).toBe(false);
  expect(
    "diagnostics" in value.check && value.check.diagnostics?.[0]?.stage,
  ).toBe("template_cleanup");
  expect(JSON.stringify(value)).not.toContain("cleanup-fixture");
});
