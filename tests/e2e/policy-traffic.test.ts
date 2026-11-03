import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { policyTrafficFixture } from "../helpers/policy-traffic-fixture.js";
import type { buildPolicySummary } from "../../src/reporting/policy-summary.js";
import { dockerClient } from "../../src/docker/client.js";

// 实际MCP安装环境，首次TLS请求经过明确工具入口；上游CA仅注入测试代理。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实任务HTTPS首次请求、最小命中、直通与故障报告",
  async () => {
    const fixture = await policyTrafficFixture();
    try {
      const catalog = `${fixture.root}/clients.json`,
        client = `${fixture.root}/traffic-client.py`,
        python = `${fixture.root}/traffic-python.py`;
      const value = fixture.values[0]!,
        marker = "UNIQUE_SYNTHETIC_BODY_NOT_FOR_EVIDENCE";
      const forms = [
        value,
        [...Buffer.from(value)]
          .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
          .join(""),
        Buffer.from(value).toString("base64"),
        Buffer.from(value).toString("base64url"),
      ];
      const good = "https://127.0.0.1:18443/";
      const requests = [
        [
          "python3",
          client,
          catalog,
          "curl",
          "--disable",
          "--silent",
          "--show-error",
          "--data-binary",
          `${marker}:${forms[0]}`,
          good,
        ],
        [
          "python3",
          client,
          catalog,
          "wget",
          "--no-config",
          "--quiet",
          "--output-document",
          "-",
          "--post-data",
          forms[1]!,
          good,
        ],
        [
          "python3",
          python,
          catalog,
          "--method",
          "POST",
          "--data",
          forms[2]!,
          good,
        ],
        [
          "python3",
          client,
          catalog,
          "curl",
          "--disable",
          "--silent",
          "--data-binary",
          forms[3]!,
          good,
        ],
      ];
      for (const argv of requests) {
        const result = await fixture.run(argv);
        expect(result.exitCode).toBe(0);
        expect(result.output).toBe("ok");
      }
      const plain = await fixture.run([
        "python3",
        client,
        catalog,
        "curl",
        "--disable",
        "--silent",
        "--cacert",
        "/tmp/fixture-ca.pem",
        good,
      ]);
      expect(plain.exitCode).toBe(0);
      expect(plain.output).toContain("unsupported-arguments");
      const bad = await fixture.run([
        "python3",
        client,
        catalog,
        "curl",
        "--disable",
        "--silent",
        "--fail",
        "https://127.0.0.1:18444/",
      ]);
      expect(bad.exitCode).not.toBe(0);
      const result = await fixture.tool<{
        policy: Awaited<ReturnType<typeof buildPolicySummary>>;
      }>("get_result", { id: fixture.task.id });
      expect(result.policy.traffic.eventCount).toBeGreaterThanOrEqual(4);
      expect(
        result.policy.traffic.events.every(
          (event) => event.runtimeId === fixture.state.summary.runtimeId,
        ),
      ).toBe(true);
      const contexts = result.policy.traffic.events.map(
        (event) => event.invocation,
      );
      expect(
        contexts.every((context) => context?.source === "client-reported"),
      ).toBe(true);
      expect(
        new Set(contexts.map((context) => context?.invocationId)).size,
      ).toBe(4);
      expect(new Set(contexts.map((context) => context?.requestId)).size).toBe(
        4,
      );
      expect(new Set(contexts.map((context) => context?.tool))).toEqual(
        new Set(["curl", "wget", "python"]),
      );
      const encodings = result.policy.traffic.events.map(
        (event) => event.encoding,
      );
      for (const encoding of ["raw", "url-percent", "base64", "base64url"])
        expect(encodings).toContain(encoding);
      for (const forbidden of [...fixture.values, marker])
        expect(JSON.stringify(result).includes(forbidden)).toBe(false);
      const evidence = join(fixture.state.handle!.privateDirectory, "evidence");
      for (const name of await readdir(evidence)) {
        const data = await readFile(join(evidence, name), "utf8");
        for (const forbidden of [...fixture.values, marker])
          expect(data.includes(forbidden)).toBe(false);
      }
      const inspect = await fixture.proxy.inspect();
      expect(inspect.HostConfig.NetworkMode).toBe(
        `container:${fixture.task.containerId}`,
      );
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(inspect.HostConfig.LogConfig?.Type).toBe("none");
      await fixture.proxy.kill();
      await fixture.supervise();
      const fallback = await fixture.run([
        "python3",
        client,
        catalog,
        "curl",
        "--disable",
        "--silent",
        "http://127.0.0.1:18081/",
      ]);
      expect(fallback.exitCode).toBe(0);
      expect(fallback.output).toContain("proxy-unavailable");
      const degraded = await fixture.tool<{
        policy: Awaited<ReturnType<typeof buildPolicySummary>>;
      }>("get_result", { id: fixture.task.id });
      expect(degraded.policy.traffic.gaps).toContain("proxy-unavailable");
      expect(
        (await dockerClient().getContainer(fixture.task.containerId!).inspect())
          .State.Running,
      ).toBe(true);
      await fixture.tool("cleanup_task", { id: fixture.task.id });
      const report = await fixture.tool<{ userMessage: string }>(
        "report_task",
        { id: fixture.task.id },
      );
      expect(report.userMessage).toContain("不等同恶意");
      expect(report.userMessage).toContain("PID=");
      expect(report.userMessage).toContain("未经内核核验");
      expect(report.userMessage).toContain("未命中不代表");
      for (const forbidden of [...fixture.values, marker])
        expect(JSON.stringify(report).includes(forbidden)).toBe(false);
    } finally {
      await fixture.finish();
    }
  },
  180000,
);
