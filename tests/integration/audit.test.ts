import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { startAudit } from "../../src/audit/collector.js";
import { configSchema } from "../../src/config/schema.js";
// 只使用假敏感文件，验证宿主采集可见成功、失败和短命进程。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "cgroup 审计捕获内层敏感访问，报告缺口",
  async () => {
    const docker = dockerClient(),
      image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect()).Id;
    const handle = await createRuntime(
      docker,
      randomUUID(),
      image,
      image,
      configSchema.parse({}),
    );
    const root = await mkdtemp(join(tmpdir(), "relay-audit-"));
    try {
      const session = await startAudit(
        docker,
        handle.containerId,
        "test",
        join(root, "audit.jsonl"),
      );
      await execute(
        docker,
        handle.containerId,
        [
          "sh",
          "-c",
          "echo fake > /home/node/.bashrc; cat /home/node/.ssh/missing; echo replacement > /home/node/temp; mv /home/node/temp /home/node/.bashrc; rm /home/node/.bashrc",
        ],
        {},
        5000,
        4096,
      );
      const report = await session.finish();
      expect(report.coverage, JSON.stringify(report)).toBe("partial");
      expect(
        report.events.some(
          (event) =>
            event.target === "/home/node/.bashrc" && event.result === "success",
        ),
      ).toBe(true);
      expect(
        report.events.some(
          (event) =>
            event.target === "/home/node/.ssh/missing" &&
            event.result === "blocked",
        ),
      ).toBe(true);
      expect(
        report.events.some(
          (event) =>
            event.action === "rename" && event.target === "/home/node/.bashrc",
        ),
      ).toBe(true);
      expect(report.gaps.length).toBeGreaterThan(0);
    } finally {
      await removeRuntime(docker, handle);
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
