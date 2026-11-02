import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeOptions } from "../permissions/types.js";
import { selectTaskSubnet } from "../network/task-boundaries.js";
import type Docker from "dockerode";
import type { Config } from "../config/schema.js";
import { installPolicy } from "../network/policy.js";
export interface RuntimeHandle {
  containerId: string;
  networkId: string;
}

// 固定参数创建容器；挂载仅接受可信资源准备器生成的明确选项。
export async function createRuntime(
  docker: Docker,
  id: string,
  image: string,
  networkImage: string,
  config: Config,
  ownerId = id,
  options: RuntimeOptions = {},
): Promise<RuntimeHandle> {
  const labels = { "relay-sandbox.task": ownerId };
  // 读取实际路由与网络，拒绝专用池冲突；不修改宿主网络配置。
  const { stdout } = await promisify(execFile)("ip", ["-j", "-4", "route"], {
    timeout: 10000,
  });
  const routes: unknown = JSON.parse(stdout);
  if (!Array.isArray(routes)) throw new Error("宿主路由格式非法");
  const subnets = routes.map((route: { dst?: string }) => {
    if (route.dst === "default") return "0.0.0.0/0";
    if (!route.dst) throw new Error("宿主路由缺少目标");
    return route.dst.includes("/") ? route.dst : `${route.dst}/32`;
  });
  const subnet = selectTaskSubnet(await docker.listNetworks(), subnets);
  const network = await docker.createNetwork({
    Name: `relay-${id}`,
    Driver: "bridge",
    Internal: false,
    Labels: labels,
    EnableIPv6: false,
    IPAM: { Config: [{ Subnet: subnet }] },
  });
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      name: `relay-${id}`,
      Image: image,
      User: "1000:1000",
      Cmd: ["sleep", "infinity"],
      WorkingDir: "/workspace",
      Env: ["HOME=/home/node"],
      Labels: labels,
      HostConfig: {
        NetworkMode: network.id,
        ...(options.mounts ? { Mounts: options.mounts } : {}),
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: config.resources.memoryMiB * 1024 * 1024,
        NanoCpus: Math.round(config.resources.cpus * 1e9),
        PidsLimit: config.resources.pids,
        Init: true,
        Sysctls: {
          "net.ipv6.conf.all.disable_ipv6": "1",
          "net.ipv6.conf.default.disable_ipv6": "1",
        },
      },
    });
    await container.start();
    await installPolicy(
      docker,
      container.id,
      network.id,
      networkImage,
      config.network.hostAddresses,
      options.network,
    );
    return { containerId: container.id, networkId: network.id };
  } catch (error) {
    const cleanup: unknown[] = [];
    if (container)
      try {
        await container.remove({ force: true });
      } catch (e) {
        cleanup.push(e);
      }
    try {
      await network.remove();
    } catch (e) {
      cleanup.push(e);
    }
    if (cleanup.length)
      throw new AggregateError(
        [error, ...cleanup],
        "启动失败且资源清理不完整",
        { cause: error },
      );
    throw error;
  }
}
// 用户显式终止时停止整个容器，而不是只杀一个进程组。
export async function stopRuntime(docker: Docker, id: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.State.Running) await container.stop({ t: 3 });
}
export async function removeRuntime(
  docker: Docker,
  handle: RuntimeHandle,
): Promise<void> {
  try {
    await docker
      .getContainer(handle.containerId)
      .remove({ force: true, v: true });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  try {
    await docker.getNetwork(handle.networkId).remove();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
}
