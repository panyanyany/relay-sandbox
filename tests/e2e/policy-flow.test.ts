import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { policyFixture } from "../helpers/policy-fixture.js";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import type { buildPolicySummary } from "../../src/reporting/policy-summary.js";

// 组合验收通过实际入口，不用重跑组件测试代替宿主调用链。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "实际CLI/MCP默认网络、授权端口与未来任务隔离",
  async () => {
    const fixture = await policyFixture({ projectMode: "isolated" }),
      docker = dockerClient(),
      id = randomUUID();
    const host = createServer((_req, res) => res.end("healthy-host"));
    await new Promise<void>((resolve) => host.listen(0, "0.0.0.0", resolve));
    const port = (host.address() as { port: number }).port;
    const network = await docker.createNetwork({
      Name: `relay-flow-private-${id}`,
      Labels: { "relay-sandbox.test": id },
    });
    const endpoint = await docker.createContainer({
      Image: fixture.image,
      Cmd: ["python3", "-m", "http.server", "18092"],
      Labels: { "relay-sandbox.test": id },
      HostConfig: { NetworkMode: network.id },
    });
    try {
      await endpoint.start();
      const address = Object.values(
        (await endpoint.inspect()).NetworkSettings.Networks,
      )[0]!.IPAddress;
      const first = await fixture.create();
      // 受控内网使用第二接口；Docker自身桥间隔离不代表任务策略禁止所有内网。
      await network.connect({ Container: first.containerId! });
      const run = (container: string, url: string) =>
        execute(
          docker,
          container,
          [
            "curl",
            "--noproxy",
            "*",
            "--silent",
            "--show-error",
            "--max-time",
            "2",
            url,
          ],
          {},
          5000,
          4096,
        );
      expect(
        (
          await execute(
            docker,
            endpoint.id,
            [
              "curl",
              "--retry",
              "5",
              "--retry-connrefused",
              "--retry-delay",
              "1",
              "--silent",
              "http://127.0.0.1:18092",
            ],
            {},
            15000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run(first.containerId!, `http://${address}:18092`)).exitCode,
      ).toBe(0);
      expect(
        (await run(first.containerId!, "https://example.com")).exitCode,
      ).toBe(0);
      const service = await fixture.tool<{ containerId: string }>(
        "start_service",
        { id: first.id, profile: "web" },
      );
      expect(
        (
          await execute(
            docker,
            service.containerId,
            [
              "curl",
              "--retry",
              "5",
              "--retry-connrefused",
              "--retry-delay",
              "1",
              "--silent",
              "http://127.0.0.1:18091",
            ],
            {},
            15000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run(first.containerId!, "http://127.0.0.1:18091")).exitCode,
      ).toBe(0);
      const gateway = (await docker.getNetwork(first.networkId!).inspect())
        .IPAM!.Config![0]!.Gateway!;
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
        "healthy-host",
      );
      expect(
        (await run(first.containerId!, `http://${gateway}:${port}`)).exitCode,
      ).not.toBe(0);
      const second = await fixture.create();
      const later = await fixture.tool<{ containerId: string }>(
        "start_service",
        { id: second.id, profile: "web" },
      );
      expect(
        (
          await execute(
            docker,
            later.containerId,
            [
              "curl",
              "--retry",
              "5",
              "--retry-connrefused",
              "--retry-delay",
              "1",
              "--silent",
              "http://127.0.0.1:18091",
            ],
            {},
            15000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      const secondIp = Object.values(
        (await docker.getContainer(second.containerId!).inspect())
          .NetworkSettings.Networks,
      )[0]!.IPAddress;
      expect(
        (await run(first.containerId!, `http://${secondIp}:18091`)).exitCode,
      ).not.toBe(0);
      await fixture.permissions({
        project: { mode: "isolated" },
        network: {
          grants: [{ target: "198.19.0.0/16", ports: [port], protocol: "tcp" }],
        },
      });
      const authorized = await fixture.create();
      const ownGateway = (
        await docker.getNetwork(authorized.networkId!).inspect()
      ).IPAM!.Config![0]!.Gateway!;
      expect(
        (await run(authorized.containerId!, `http://${ownGateway}:${port}`))
          .output,
      ).toBe("healthy-host");
      expect(
        (await run(first.containerId!, `http://${gateway}:${port}`)).exitCode,
      ).not.toBe(0);
      const result = await fixture.tool<{
        policy: Awaited<ReturnType<typeof buildPolicySummary>>;
      }>("get_result", { id: authorized.id });
      expect(result.policy.network.grants[0]?.ports).toEqual([port]);
    } finally {
      await fixture.finish();
      await endpoint.remove({ force: true });
      await network.remove();
      await new Promise<void>((resolve, reject) =>
        host.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  180000,
);

// 安装写用户配置照常，直接写入风险与项目交付状态分别报告。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实入口资源副本、只读、可写及默认关闭清理",
  async () => {
    const fixture = await policyFixture({ projectMode: "isolated" }),
      docker = dockerClient();
    const resources = [];
    for (const [name, mode, access] of [
      ["copy", "copy", "read-write"],
      ["readonly", "direct", "read-only"],
      ["writable", "direct", "read-write"],
    ] as const) {
      const source = join(fixture.directory, name);
      await mkdir(source);
      await chmod(source, 0o777);
      await writeFile(join(source, "data"), "host", { mode: 0o666 });
      resources.push({
        name,
        source,
        target: `/resources/${name}`,
        mode,
        access,
      });
    }
    try {
      await fixture.permissions({ project: { mode: "isolated" }, resources });
      const task = await fixture.create();
      const run = (code: string) =>
        execute(docker, task.containerId!, ["sh", "-c", code], {}, 5000, 4096);
      expect(
        (
          await run(
            "printf changed > /resources/copy/data; printf changed > /resources/writable/data",
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run("printf denied > /resources/readonly/data")).exitCode,
      ).not.toBe(0);
      expect(
        (
          await run(
            "mkdir -p /home/node/.config/fixture-tool; printf normal > /home/node/.config/fixture-tool/config; test ! -e /home/node/.config/relay-sandbox/decoys",
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run("printf denied > /etc/relay-fixture")).exitCode,
      ).not.toBe(0);
      expect(await readFile(join(fixture.directory, "copy/data"), "utf8")).toBe(
        "host",
      );
      expect(
        await readFile(join(fixture.directory, "writable/data"), "utf8"),
      ).toBe("changed");
      const result = await fixture.tool<{
        policy: Awaited<ReturnType<typeof buildPolicySummary>>;
      }>("get_result", { id: task.id });
      expect(result.policy.traffic.coverage).toBe("disabled");
      expect(result.policy.directHostWritesPossible).toBe(true);
      expect(
        await docker.listContainers({
          all: true,
          filters: { label: [`relay-sandbox.task=${task.id}`] },
        }),
      ).toHaveLength(1);
      await fixture.permissions({
        project: { mode: "isolated" },
        resources: [],
      });
      expect((await run("cat /resources/copy/data")).output).toBe("changed");
      await fixture.tool("cleanup_task", { id: task.id });
      const report = await fixture.tool<{
        userMessage: string;
        originalProjectChangedByTask: boolean;
      }>("report_task", { id: task.id });
      expect(report.originalProjectChangedByTask).toBe(false);
      expect(report.userMessage).toContain("直接可写");
      expect(
        await readFile(join(fixture.directory, "writable/data"), "utf8"),
      ).toBe("changed");
      expect(
        await readFile(join(fixture.directory, "readonly/data"), "utf8"),
      ).toBe("host");
    } finally {
      await fixture.finish();
    }
  },
  120000,
);
