import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { registerProject } from "../../src/projects/registry.js";
import { createTask } from "../../src/tasks/create.js";
import { runTask } from "../../src/tasks/run.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { applyTask, reviewTask } from "../../src/tasks/deliver.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";

// 真实调用须显式启用；凭据仅从进程环境读取，不复制宿主配置。
test.skipIf(process.env.RELAY_LIVE_TEST !== "1").each([
  ["codex", "responses", "https://api.deepseek.com"],
  ["claude-code", "anthropic", "https://api.deepseek.com/anthropic"],
  ["opencode", "openai-compatible", "https://api.deepseek.com"],
] as const)(
  "%s 经真实 DeepSeek 完成代码交付",
  async (type, protocol, endpoint) => {
    expect(process.env.RELAY_LIVE_KEY).toBeTruthy();
    const root = await mkdtemp(join(tmpdir(), "relay-live-"));
    const home = join(root, "home"),
      project = join(root, "project");
    let taskId: string | undefined;
    try {
      await mkdir(project);
      await mkdir(join(home, "profiles"), { recursive: true });
      const image = (
        await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
      ).Id;
      await writeFile(
        join(project, "sum.cjs"),
        "// 返回两个数字的和。\nmodule.exports = (a, b) => a - b;\n",
      );
      await writeFile(
        join(project, "test.cjs"),
        "const assert = require('node:assert/strict'); const sum = require('./sum.cjs'); assert.equal(sum(2, 3), 5); assert.equal(sum(-2, 4), 2);\n",
      );
      await writeFile(
        join(project, "relay-sandbox.yaml"),
        stringify({
          developmentAgent: { type },
          lifecycle: { taskTimeoutMinutes: 4 },
          delivery: {
            aiReview: true,
            checks: [{ name: "sum", argv: ["node", "test.cjs"] }],
          },
        }),
      );
      await writeFile(
        join(home, "profiles/relay-default.yaml"),
        stringify({
          endpoint,
          protocol,
          model: "deepseek-flash",
          apiKeyEnv: "RELAY_LIVE_KEY",
          image,
          networkImage: image,
        }),
      );
      await registerProject(home, "live", project);
      const task = await createTask(
        home,
        "live",
        "Fix sum.cjs so it adds two numbers. Keep the Chinese comment. Change only sum.cjs. Run node test.cjs to verify. Do not change tests or configuration.",
      );
      taskId = task.id;
      await runTask(home, task.id);
      const prepared = await prepareDelivery(home, task.id);
      expect(prepared.task.checks[0]?.status).toBe("passed");
      // 宿主检查最终候选，再绑定摘要批准；这不代替宿主模型 MCP 会话验收。
      const candidate = join(home, "tasks", task.id, "candidate");
      const code = await readFile(join(candidate, "sum.cjs"), "utf8");
      expect(code).toMatch(/a\s*\+\s*b/);
      expect(await readFile(join(candidate, "test.cjs"), "utf8")).toBe(
        await readFile(join(project, "test.cjs"), "utf8"),
      );
      await reviewTask(home, task.id, {
        taskId: task.id,
        artifactDigest: prepared.task.artifactDigest!,
        configDigest: task.configDigest,
        schemaVersion: 1,
        verdict: "approve",
        findings: [],
        summary: "宿主核对候选加法实现、测试文件未改及独立检查通过",
      });
      expect((await applyTask(home, task.id)).state).toBe("completed");
      expect(await readFile(join(project, "sum.cjs"), "utf8")).toBe(code);
    } finally {
      if (taskId) await cleanupTask(home, taskId);
      await rm(root, { recursive: true, force: true });
    }
  },
  300000,
);
