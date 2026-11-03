import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, taskPath } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";
import { taskEventUri } from "../../src/mcp/task-events.js";

// 使用真实stdio协议与独立写入进程，覆盖后台任务的原子文件替换。
test("任务资源订阅捕获跨进程更新，取消与重连隔离且可重新订阅", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-task-events-"));
  const task: Task = {
    id: "event-task",
    projectId: "project",
    projectRoot: "/unused",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "running",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
  };
  await saveTask(home, task);
  const connect = async () => {
    const client = new Client({ name: "event-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
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
      }),
    );
    return client;
  };
  let client: Client | undefined;
  const uri = taskEventUri(task.id);
  const write = async (state: string) => {
    await promisify(execFile)(process.execPath, [
      "-e",
      `
      const fs = require('node:fs'); const file = process.argv[1];
      const task = JSON.parse(fs.readFileSync(file)); task.state = process.argv[2];
      fs.writeFileSync(file + '.tmp', JSON.stringify(task)); fs.renameSync(file + '.tmp', file);
    `,
      join(taskPath(home, task.id), "task.json"),
      state,
    ]);
  };
  try {
    client = await connect();
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
    const template = await client.listResourceTemplates();
    expect(
      template.resourceTemplates.some(
        (item) => item.uriTemplate === "relay-sandbox://tasks/{id}",
      ),
    ).toBe(true);
    await expect(
      client.subscribeResource({ uri: "file:///etc/passwd" }),
    ).rejects.toThrow();
    await expect(
      client.subscribeResource({ uri: taskEventUri("missing") }),
    ).rejects.toThrow();
    const notifications: string[] = [];
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        notifications.push(notification.params.uri);
      },
    );
    await client.subscribeResource({ uri });
    await client.subscribeResource({ uri });
    await write("checking");
    await expect.poll(() => notifications.length).toBeGreaterThan(0);
    expect(notifications.every((item) => item === uri)).toBe(true);
    const snapshot = await client.readResource({ uri });
    const content = snapshot.contents[0]!;
    if (!("text" in content)) throw new Error("任务快照应为文本资源");
    expect(JSON.parse(content.text).task.state).toBe("checking");
    await client.unsubscribeResource({ uri });
    await setTimeout(80);
    const count = notifications.length;
    await write("ready");
    await setTimeout(120);
    expect(notifications.length).toBe(count);
    await client.close();
    client = await connect();
    const reconnected: string[] = [];
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        reconnected.push(notification.params.uri);
      },
    );
    await write("running");
    await setTimeout(100);
    expect(reconnected).toEqual([]);
    const subscribed = await client.callTool({
      name: "subscribe_task_events",
      arguments: { id: task.id },
    });
    expect(subscribed.isError).not.toBe(true);
    await write("completed");
    await expect.poll(() => reconnected.length).toBeGreaterThan(0);
    const result = await client.callTool({
      name: "unsubscribe_task_events",
      arguments: { id: task.id },
    });
    expect(result.isError).not.toBe(true);
  } finally {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
