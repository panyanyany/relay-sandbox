import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import {
  createRuntime,
  removeRuntime,
  type RuntimeHandle,
} from "../../src/docker/runtime.js";
import { dockerClient } from "../../src/docker/client.js";
import { installPolicy } from "../../src/network/policy.js";
import { execute } from "../../src/docker/execute.js";

// 专用真实端点给出成功对照；不使用不存在地址或公网超时充当隔离证据。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实默认内网、宿主例外与未来跨任务隔离",
  async () => {
    const docker = dockerClient(),
      id = randomUUID();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const handles: RuntimeHandle[] = [];
    const server = createServer((_request, response) =>
      response.end("host-authorized"),
    );
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    const network = await docker.createNetwork({
      Name: `relay-test-private-${id}`,
      Labels: { "relay-sandbox.test": id },
      IPAM: { Config: [{ Subnet: "192.168.247.0/24" }] },
    });
    const endpoint = await docker.createContainer({
      Image: image,
      Cmd: ["python3", "-m", "http.server", "8097"],
      HostConfig: { NetworkMode: network.id },
      Labels: { "relay-sandbox.test": id },
    });
    await endpoint.start();
    const curl = (containerId: string, url: string, ready = false) =>
      execute(
        docker,
        containerId,
        [
          "curl",
          ...(ready
            ? ["--retry", "5", "--retry-connrefused", "--retry-delay", "1"]
            : []),
          "--noproxy",
          "*",
          "--max-time",
          "3",
          "--silent",
          "--show-error",
          url,
        ],
        {},
        ready ? 20000 : 5000,
        4096,
      );
    try {
      const first = await createRuntime(
        docker,
        id,
        image,
        image,
        configSchema.parse({}),
        id,
        { network: { mode: "default-open", grants: [] } },
      );
      handles.push(first);
      const net = await docker.getNetwork(first.networkId).inspect();
      const gateway = net.IPAM?.Config?.[0]?.Gateway;
      expect(net.IPAM?.Config?.[0]?.Subnet).toMatch(/^198\.19\./);
      expect(
        (await curl(first.containerId, `http://${gateway}:${port}`)).exitCode,
      ).not.toBe(0);
      // 将受控外部内网夹具接入第二接口；不改宿主路由或防火墙。
      await network.connect({ Container: first.containerId });
      const endpointInfo = await endpoint.inspect();
      const privateAddress =
        endpointInfo.NetworkSettings.Networks[(await network.inspect()).Name]
          ?.IPAddress;
      expect(
        (await curl(first.containerId, `http://${privateAddress}:8097`))
          .exitCode,
      ).toBe(0);
      expect(
        (await curl(first.containerId, "https://example.com")).exitCode,
      ).toBe(0);
      const service = await docker.createContainer({
        Image: image,
        Cmd: ["python3", "-m", "http.server", "8098"],
        HostConfig: { NetworkMode: `container:${first.containerId}` },
        Labels: { "relay-sandbox.task": id },
      });
      try {
        await service.start();
        expect(
          (await curl(first.containerId, "http://127.0.0.1:8098", true))
            .exitCode,
        ).toBe(0);
      } finally {
        await service.remove({ force: true });
      }
      const secondId = randomUUID();
      const second = await createRuntime(
        docker,
        secondId,
        image,
        image,
        configSchema.parse({}),
        secondId,
        { network: { mode: "default-open", grants: [] } },
      );
      handles.push(second);
      // 与后来任务共享受控内网接口，使成功路由不依赖 Docker 跨桥默认策略。
      await network.connect({ Container: second.containerId });
      const secondInfo = await docker
        .getContainer(second.containerId)
        .inspect();
      const laterIp = Object.values(secondInfo.NetworkSettings.Networks).find(
        (item) => item.IPAddress.startsWith("198.19."),
      )?.IPAddress;
      const privateName = (await network.inspect()).Name;
      const firstInfo = await docker.getContainer(first.containerId).inspect();
      const firstPrivate =
        firstInfo.NetworkSettings.Networks[privateName]!.IPAddress;
      const secondPrivate =
        secondInfo.NetworkSettings.Networks[privateName]!.IPAddress;
      // 只在测试任务命名空间安装可达路线，为同一目标提供授权成功对照。
      const routeHelper = await docker.createContainer({
        Image: image,
        User: "0:0",
        Cmd: [
          "ip",
          "route",
          "replace",
          `${laterIp}/32`,
          "via",
          secondPrivate,
          "src",
          firstPrivate,
        ],
        HostConfig: {
          NetworkMode: `container:${first.containerId}`,
          CapDrop: ["ALL"],
          CapAdd: ["NET_ADMIN"],
        },
        Labels: {
          "relay-sandbox.task": id,
          "relay-sandbox.kind": "test-route",
        },
      });
      try {
        await routeHelper.start();
        expect((await routeHelper.wait()).StatusCode).toBe(0);
      } finally {
        await routeHelper.remove({ force: true });
      }
      const laterServer = await docker.createContainer({
        Image: image,
        Cmd: ["python3", "-m", "http.server", "8099"],
        HostConfig: { NetworkMode: `container:${second.containerId}` },
        Labels: { "relay-sandbox.task": secondId },
      });
      try {
        await laterServer.start();
        expect(
          (await curl(second.containerId, "http://127.0.0.1:8099", true))
            .exitCode,
        ).toBe(0);
        expect(
          (await curl(first.containerId, `http://${laterIp}:8099`)).exitCode,
        ).not.toBe(0);
        await installPolicy(
          docker,
          first.containerId,
          first.networkId,
          image,
          [],
          {
            mode: "default-open",
            grants: [{ target: laterIp!, ports: [8099], protocol: "tcp" }],
          },
        );
        expect(
          (await curl(first.containerId, `http://${laterIp}:8099`)).exitCode,
        ).toBe(0);
      } finally {
        await laterServer.remove({ force: true });
      }
      const authorizedId = randomUUID();
      const authorized = await createRuntime(
        docker,
        authorizedId,
        image,
        image,
        configSchema.parse({}),
        authorizedId,
        {
          network: {
            mode: "default-open",
            grants: [
              { target: "198.19.0.0/16", ports: [port], protocol: "tcp" },
            ],
          },
        },
      );
      handles.push(authorized);
      const authorizedNet = await docker
        .getNetwork(authorized.networkId)
        .inspect();
      expect(
        (
          await curl(
            authorized.containerId,
            `http://${authorizedNet.IPAM?.Config?.[0]?.Gateway}:${port}`,
          )
        ).output,
      ).toBe("host-authorized");
    } finally {
      for (const handle of handles.reverse())
        await removeRuntime(docker, handle);
      await endpoint.remove({ force: true });
      await network.remove();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  120000,
);

test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "规则辅助启动失败回收容器与网络",
  async () => {
    const docker = dockerClient(),
      id = randomUUID();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    await expect(
      createRuntime(
        docker,
        id,
        image,
        `sha256:${"0".repeat(64)}`,
        configSchema.parse({}),
        id,
        { network: { mode: "default-open", grants: [] } },
      ),
    ).rejects.toThrow();
    expect(
      await docker.listContainers({
        all: true,
        filters: { label: [`relay-sandbox.task=${id}`] },
      }),
    ).toEqual([]);
    expect(
      await docker.listNetworks({
        filters: { label: [`relay-sandbox.task=${id}`] },
      }),
    ).toEqual([]);
  },
  30000,
);
