import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { VERIFIED_CLIENTS } from "../../src/traffic/clients.js";
import { stopTraffic } from "../../src/traffic/runtime.js";
import { installTrafficFiles } from "../../src/traffic/install.js";
import { installEnvironment } from "../../src/tasks/environment-install.js";
import {
  listEnvironments,
  saveEnvironmentState,
  loadMainEnvironment,
} from "../../src/tasks/environment-state.js";

// 从真实组件组合验证，不mock代理、投放器或公共工具安装器。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "独立环境安装开关、私密边界和失败降级",
  async () => {
    const docker = dockerClient(),
      taskId = randomUUID();
    const home = await mkdtemp(join(tmpdir(), "relay-environment-"));
    const runtime = await createRuntime(
      docker,
      taskId,
      "relay-sandbox-dev:0.1.0",
      "relay-sandbox-dev:0.1.0",
      configSchema.parse({}),
      taskId,
      { network: { mode: "default-open", grants: [] } },
    );
    const policy = {
      schemaVersion: 1 as const,
      ...hostPermissionsSchema.parse({
        decoys: { enabled: true, clients: VERIFIED_CLIENTS },
      }),
    };
    const install = (
      runtimeId: string,
      enabled = true,
      role: "main" | "check" = "main",
    ) =>
      installEnvironment(docker, {
        home,
        taskId,
        runtimeId,
        containerId: runtime.containerId,
        policy: { ...policy, decoys: { ...policy.decoys, enabled } },
        role,
      });
    try {
      expect((await install("disabled", false)).summary.traffic).toBe(
        "disabled",
      );
      expect(
        await readdir(join(home, "tasks", taskId)).catch(() => []),
      ).toEqual([]);
      const main = await install("main-1");
      expect(main.summary.traffic).toBe("ready");
      expect(
        main.summary.placements.every((item) => item.status === "installed"),
      ).toBe(true);
      const helper = main.summary.helperRoot!;
      expect(
        (
          await execute(
            docker,
            runtime.containerId,
            ["test", "-r", `${helper}/ca.pem`],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await execute(
            docker,
            runtime.containerId,
            [
              "python3",
              "-c",
              `import json;json.load(open('${helper}/clients.json'))`,
            ],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await execute(
            docker,
            runtime.containerId,
            ["test", "-e", "/ca/mitmproxy-ca.pem"],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).not.toBe(0);
      const manifestText = await readFile(
        join(home, "tasks", taskId, "decoys", "manifest.json"),
        "utf8",
      );
      const values = (
        JSON.parse(manifestText) as { entries: { value: string }[] }
      ).entries.map((entry) => entry.value);
      const summary = await readFile(
        join(home, "tasks", taskId, "traffic", "main-1", "summary.json"),
        "utf8",
      );
      const handle = await readFile(
        join(home, "tasks", taskId, "traffic", "main-1", "handle.json"),
        "utf8",
      );
      expect(
        values.every(
          (value) => !summary.includes(value) && !handle.includes(value),
        ),
      ).toBe(true);
      expect(
        handle.includes("PRIVATE KEY") || handle.includes("CERTIFICATE"),
      ).toBe(false);
      await stopTraffic(docker, main.handle!);
      delete main.handle;
      main.summary.traffic = "stopped";
      await saveEnvironmentState(home, taskId, main);
      expect((await loadMainEnvironment(home, taskId))?.handle).toBeUndefined();
      // 检查环境角色独立；同一个容器内已有诱饵会被跳过，不伪称重新投放。
      const check = await install("check-1", true, "check");
      expect(check.summary.traffic).toBe("ready");
      expect(check.summary.gaps).toContain("historical-decoys-unconfirmed");
      expect(
        check.summary.placements.every((item) => item.status === "skipped"),
      ).toBe(true);
      expect((await loadMainEnvironment(home, taskId))?.summary.runtimeId).toBe(
        "main-1",
      );
      // 使用另一个真实干净运行时，避免已有诱饵导致没有代理启动机会。
      const second = await createRuntime(
        docker,
        `${taskId}-second`,
        "relay-sandbox-dev:0.1.0",
        "relay-sandbox-dev:0.1.0",
        configSchema.parse({}),
        taskId,
        { network: { mode: "default-open", grants: [] } },
      );
      try {
        await installTrafficFiles(docker, second.containerId, "conflict", [
          { name: "clients.json", content: "existing-public" },
        ]);
        const failed = await installEnvironment(docker, {
          home,
          taskId,
          runtimeId: "conflict",
          containerId: second.containerId,
          policy,
        });
        expect(failed.summary.traffic).toBe("unavailable");
        expect(failed.summary.gaps).toContain("traffic-tools-failed");
        expect(failed.handle).toBeUndefined();
        expect(
          (
            await execute(
              docker,
              second.containerId,
              ["cat", "/opt/relay-sandbox/audit/conflict/clients.json"],
              {},
              5000,
              4096,
            )
          ).output,
        ).toBe("existing-public");
      } finally {
        await removeRuntime(docker, second);
      }
      expect(
        (await listEnvironments(home, taskId))
          .map((state) => state.summary.runtimeId)
          .sort(),
      ).toEqual(["check-1", "conflict", "main-1"]);
    } finally {
      for (const state of await listEnvironments(home, taskId))
        if (state.handle) await stopTraffic(docker, state.handle);
      await removeRuntime(docker, runtime);
      await rm(home, { recursive: true, force: true });
    }
  },
  90000,
);
