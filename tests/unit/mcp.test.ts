import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask } from "../../src/tasks/store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// 使用真实 stdio 握手和工具枚举，防止 stdout 日志破坏 MCP 协议。
test("stdio MCP 可发现工具，不能注册任意宿主路径", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("src/cli/main.ts"),
      "--home",
      home,
      "mcp",
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "fixture", version: "1.0" });
  try {
    await client.connect(transport);
    expect(client.getInstructions()).toContain("get_capabilities");
    const tools = await client.listTools();
    expect(tools.tools.every((tool) => Boolean(tool.description))).toBe(true);
    const capabilities = await client.callTool({
      name: "get_capabilities",
      arguments: {},
    });
    const capabilityContent = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(capabilities.content);
    const capability = JSON.parse(capabilityContent[0]!.text);
    expect(capability.observation.boundedWait.supported).toBe(true);
    expect(capability.observation.eventHooks.supported).toBe(true);
    expect(capability.observation.hostWakeup.supported).toBe(false);
    expect(capability.configuration.secretsAcceptedByMcp).toBe(true);
    expect(capability.configuration.userProvidedSecretsOnly).toBe(true);
    expect(capability.permissions.source).toBe("host_only");
    expect(capability.permissions.mutableDuringTask).toBe(false);
    expect(capability.network.externalIntranetDefault).toBe("allow");
    expect(capability.trafficAudit.defaultEnabled).toBe(false);
    expect(capability.trafficAudit.verifiedClients).toHaveLength(3);
    expect(capability.trafficAudit.interception).toBe("explicit_helpers_only");
    expect(capability.trafficAudit.failureBlocksCommunication).toBe(false);

    for (const name of [
      "get_capabilities",
      "wait_task",
      "subscribe_task_events",
      "unsubscribe_task_events",
      "get_task_event_subscription",
      "set_relay_credential",
      "initialize_relay",
      "import_relay_configuration",
      "get_relay_configuration",
      "configure_relay",
      "check_relay_configuration",
    ]) {
      expect(tools.tools.map((tool) => tool.name)).toContain(name);
    }
    expect(tools.tools.map((tool) => tool.name)).toContain("prepare_delivery");
    expect(tools.tools.map((tool) => tool.name)).not.toContain(
      "register_project",
    );
    // 经 SDK 验证实际工具契约，避免 schema 枚举正确但提交参数不可用。
    await saveTask(home, {
      id: "review",
      projectId: "p",
      projectRoot: "/unused",
      prompt: "x",
      config: configSchema.parse({}),
      configDigest: "c",
      applicationStatus: "not_attempted",
      artifactDigest: "a",
      deliveryPrepared: true,
      state: "checking",
      createdAt: "",
      updatedAt: "",
      round: 1,
      checks: [],
      warnings: [],
    });
    const status = await client.callTool({
      name: "get_task",
      arguments: { id: "review" },
    });
    const content = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(status.content);
    const snapshot = z
      .object({ revision: z.string().length(64) })
      .parse(JSON.parse(content[0]!.text));
    const waited = await client.callTool({
      name: "wait_task",
      arguments: {
        id: "review",
        afterRevision: snapshot.revision,
        timeoutSeconds: 1,
      },
    });
    const waitContent = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(waited.content);
    expect(JSON.parse(waitContent[0]!.text).reason).toBe("timeout");
    const changedWait = client.callTool({
      name: "wait_task",
      arguments: {
        id: "review",
        afterRevision: snapshot.revision,
        timeoutSeconds: 3,
      },
    });
    const review = await client.callTool({
      name: "review_task",
      arguments: {
        id: "review",
        decision: {
          schemaVersion: 1,
          taskId: "review",
          artifactDigest: "a",
          configDigest: "c",
          verdict: "reject",
          summary: "发现风险",
          findings: [],
        },
      },
    });
    expect(review.isError).not.toBe(true);
    const changed = await changedWait;
    const changedContent = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(changed.content);
    expect(JSON.parse(changedContent[0]!.text).reason).toBe("changed");
    expect((await getTask(home, "review")).state).toBe("blocked");
    const reportResponse = await client.callTool({
      name: "report_task",
      arguments: { id: "review" },
    });
    expect(reportResponse.isError).not.toBe(true);
    const reportContent = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(reportResponse.content);
    const report = JSON.parse(reportContent[0]!.text);
    expect(report.emissionStatus).toBe("prepared");
    expect(report.userMessage).toContain("已阻止交付");
    expect(report.reportId).toHaveLength(64);
    const result = await client.callTool({
      name: "start_task",
      arguments: { project: "../outside", prompt: "test" },
    });
    expect(result.isError).toBe(true);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
