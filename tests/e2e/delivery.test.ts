import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { registerProject } from "../../src/projects/registry.js";
import { createEphemeralTask as createTask } from "../helpers/ephemeral-task.js";
import { runTask } from "../../src/tasks/run.js";
import { checkAndRepair } from "../../src/tasks/check-and-repair.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { applyTask, reviewTask } from "../../src/tasks/deliver.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";
// 本地中转站只返回确定性响应；不使用宿主订阅或真实 API 密钥。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1").each([
  ["codex", "responses", "pass"],
  ["claude-code", "anthropic", "pass"],
  ["opencode", "openai-compatible", "pass"],
  ["codex", "responses", "fail"],
] as const)(
  "%s 通过假中转站调用容器工具并交付",
  async (type, protocol, mode) => {
    const root = await mkdtemp(join(tmpdir(), "relay-e2e-")),
      home = join(root, "home"),
      project = join(root, "project");
    await mkdir(project);
    await mkdir(join(home, "profiles"), { recursive: true });
    const image = (
      await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
    ).Id;
    await writeFile(
      join(project, "relay-server.mjs"),
      await readFile(resolve("tests/fixtures/relay-server.mjs")),
    );
    await writeFile(
      join(project, "relay-sandbox.yaml"),
      stringify({
        hostAgent: { type: type === "codex" ? "claude-code" : "codex" },
        developmentAgent: { type },
        delivery:
          mode === "fail"
            ? {
                aiReview: false,
                maxRepairRounds: 1,
                checks: [
                  {
                    name: "always-fail",
                    argv: ["node", "-e", "process.exit(1)"],
                  },
                ],
              }
            : type === "codex"
              ? {
                  aiReview: true,
                  checks: [
                    {
                      name: "file-content",
                      argv: [
                        "node",
                        "-e",
                        'if(require("fs").readFileSync("delivered.txt","utf8")!=="fixture-change")process.exit(1)',
                      ],
                    },
                  ],
                }
              : { aiReview: false },
      }),
    );
    await writeFile(
      join(home, "profiles/relay-default.yaml"),
      stringify({
        endpoint: "http://127.0.0.1:18765/v1",
        model: "fixture-model",
        apiKeyEnv: "RELAY_FIXTURE_KEY",
        protocol,
        image,
        networkImage: image,
      }),
    );
    process.env.RELAY_FIXTURE_KEY = "fake-e2e-key";
    await registerProject(home, "fixture", project);
    const task = await createTask(
      home,
      "fixture",
      "Create delivered.txt with fixture-change using exec_command.",
    );
    try {
      const started = await execute(
        dockerClient(),
        task.containerId!,
        [
          "sh",
          "-c",
          "node /workspace/relay-server.mjs >/tmp/relay-fixture.log 2>&1 &",
        ],
        {},
        5000,
        4096,
      );
      expect(started.exitCode).toBe(0);
      await runTask(home, task.id);
      if (mode === "fail") {
        const failed = await checkAndRepair(home, task.id);
        expect(failed.task.state).toBe("blocked");
        expect(failed.task.repairRounds).toBe(1);
        const repeated = await checkAndRepair(home, task.id);
        expect(repeated.task.round).toBe(2);
        expect(repeated.task.state).toBe("blocked");
        return;
      }
      const prepared = await prepareDelivery(home, task.id);
      expect(prepared.task.state).toBe(type === "codex" ? "checking" : "ready");
      if (type === "codex") {
        expect(prepared.task.checks[0]?.status).toBe("passed");
        await expect(
          reviewTask(home, task.id, {
            taskId: task.id,
            artifactDigest: "stale",
            configDigest: task.configDigest,
            schemaVersion: 1,
            verdict: "approve",
            findings: [],
            summary: "fixture",
          }),
        ).rejects.toThrow("过期");
        const reworked = await runTask(
          home,
          task.id,
          "Keep the existing delivered.txt unchanged.",
        );
        expect(reworked.review).toBeUndefined();
        const final = await prepareDelivery(home, task.id);
        await reviewTask(home, task.id, {
          taskId: task.id,
          artifactDigest: final.task.artifactDigest!,
          configDigest: final.task.configDigest,
          schemaVersion: 1,
          verdict: "approve",
          findings: [],
          summary: "fixture review",
        });
      }
      expect((await applyTask(home, task.id)).state).toBe("completed");
      expect(await readFile(join(project, "delivered.txt"), "utf8")).toBe(
        "fixture-change",
      );
    } catch (error) {
      const output = await execute(
        dockerClient(),
        task.containerId!,
        [
          "sh",
          "-c",
          "tail -c 2000 /tmp/relay-fixture-request.json; cat /tmp/relay-fixture.log",
        ],
        {},
        5000,
        8192,
      );
      const log = await readFile(
        join(home, "tasks", task.id, "round-1.log"),
        "utf8",
      ).catch(() => "no round log");
      throw new Error(`${String(error)}\n${output.output}\n${log}`, {
        cause: error,
      });
    } finally {
      await cleanupTask(home, task.id);
      await rm(root, { recursive: true, force: true });
      delete process.env.RELAY_FIXTURE_KEY;
    }
  },
  120000,
);
