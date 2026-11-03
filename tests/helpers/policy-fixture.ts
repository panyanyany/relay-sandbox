import { configureEphemeralProject } from "./ephemeral-task.js";
import { deleteEnvironment } from "../../src/environments/lifecycle.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dockerClient } from "../../src/docker/client.js";
import type { Task } from "../../src/tasks/types.js";

// 使用实际CLI登记项目，实际stdio MCP创建/查询/清理，不连接真实模型接口。
export async function policyFixture(options: { persistent?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relay-policy-flow-"));
  const home = join(directory, "state"),
    project = join(directory, "project");
  const image = (
    await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
  ).Id;
  for (const path of [
    project,
    join(home, "profiles"),
    join(home, "permissions"),
    join(home, "services"),
  ])
    await mkdir(path, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    RELAY_POLICY_FLOW_KEY: "synthetic-unused",
  };
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            resolve("src/cli/main.ts"),
            "--home",
            home,
            ...args,
          ],
          { env, maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    );
  await writeFile(
    join(home, "profiles/relay-default.yaml"),
    stringify({
      endpoint: "https://fixture.invalid/v1",
      model: "fixture",
      protocol: "responses",
      apiKeyEnv: "RELAY_POLICY_FLOW_KEY",
      image,
      networkImage: image,
    }),
  );
  await writeFile(
    join(project, "relay-sandbox.yaml"),
    stringify({ delivery: { aiReview: false } }),
  );
  await writeFile(
    join(home, "services/web.yaml"),
    stringify({ image, argv: ["python3", "-m", "http.server", "18091"] }),
  );
  await cli("register", "project", project);
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
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "policy-acceptance", version: "1.0" });
  await client.connect(transport);
  async function tool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120000,
    });
    if (result.isError) throw new Error(`实际MCP ${name} 失败`);
    const content = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(result.content);
    return JSON.parse(content[0]!.text);
  }
  return {
    directory,
    home,
    project,
    image,
    tool,
    cli,
    async permissions(value: unknown) {
      await writeFile(join(home, "permissions/project.yaml"), stringify(value));
    },
    async create() {
      if (!options.persistent) await configureEphemeralProject(project);
      return tool<Task>("start_task", {
        project: "project",
        prompt: "合成行为策略验收，无需运行开发模型",
      });
    },
    async finish() {
      try {
        for (const task of (await cli("status")) as Task[])
          await tool("cleanup_task", { id: task.id });
        await deleteEnvironment(home, "project");
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
