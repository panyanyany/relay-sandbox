import { expect, test, vi } from "vitest";
import { policyFixture } from "../helpers/policy-fixture.js";
import { stopTask } from "../../src/tasks/cleanup.js";
import { resumeTask } from "../../src/tasks/recovery.js";
import { runTask } from "../../src/tasks/run.js";
import { getTask } from "../../src/tasks/store.js";
import { dockerClient } from "../../src/docker/client.js";
import * as environment from "../../src/tasks/environment-install.js";
import * as network from "../../src/network/policy.js";
import { developmentAdapter } from "../../src/agents/development/adapters.js";

// 真实公开恢复和返工入口；合成开发命令替代计费模型，审计故障注入到实际安装边界。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "恢复与runTask返工对审计和网络故障采用相同策略",
  async () => {
    const f = await policyFixture({ projectMode: "isolated" });
    try {
      await f.permissions({ project: { mode: "direct" } });
      const task = await f.create();
      await stopTask(f.home, task.id);
      vi.spyOn(environment, "installEnvironment").mockRejectedValue(
        new Error("synthetic audit EACCES"),
      );
      const restored = await resumeTask(f.home, task.id);
      expect(restored.state).toBe("prepared");
      expect(restored.warnings.join("\n")).toContain("synthetic audit EACCES");
      await stopTask(f.home, task.id);
      // 允许runTask的状态仍由公开恢复入口建立；停止资源后以已准备状态进入返工。
      await resumeTask(f.home, task.id);
      const { stopTaskResources } = await import("../../src/tasks/cleanup.js");
      await stopTaskResources(f.home, await getTask(f.home, task.id));
      vi.stubEnv("RELAY_POLICY_FLOW_KEY", "synthetic-unused");
      vi.spyOn(developmentAdapter("codex"), "launch").mockReturnValue({
        argv: ["sh", "-c", "printf repaired > repaired.txt"],
        env: {},
      });
      const reworked = await runTask(f.home, task.id);
      expect(reworked.state).toBe("checking");
      expect(
        reworked.warnings.filter((warning) =>
          warning.includes("synthetic audit EACCES"),
        ),
      ).toHaveLength(3);
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
      vi.spyOn(network, "installPolicy").mockRejectedValue(
        new Error("synthetic mandatory network failure"),
      );
      await expect(runTask(f.home, task.id)).rejects.toThrow(
        "synthetic mandatory network failure",
      );
      expect((await getTask(f.home, task.id)).state).toBe("failed");
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
      await expect(resumeTask(f.home, task.id)).rejects.toThrow(
        "synthetic mandatory network failure",
      );
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f.finish();
    }
  },
  120000,
);
