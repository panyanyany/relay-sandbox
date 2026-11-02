import { z } from "zod";

// 此地址池专供受管理任务；所有未来任务都在池内，拒绝规则无需等待刷新。
export const TASK_ADDRESS_POOL = "198.19.0.0/16";
export interface NetworkDescription {
  Id: string;
  Labels?: Record<string, string> | undefined;
  IPAM?: { Config?: { Subnet?: string | undefined }[] | undefined } | undefined;
}
export interface TaskBoundary {
  networkId: string;
  ownerId: string;
  subnet: string;
}
// 将已校验的 IPv4 网段转换成区间，供地址分配与路由碰撞验证使用。
export function subnetRange(subnet: string): [number, number] {
  z.cidrv4().parse(subnet);
  const [address, prefix] = subnet.split("/");
  const value = address!
    .split(".")
    .reduce((total, part) => total * 256 + Number(part), 0);
  const size = 2 ** (32 - Number(prefix));
  const start = Math.floor(value / size) * size;
  return [start, start + size - 1];
}
export function subnetsOverlap(left: string, right: string): boolean {
  const [a, b] = subnetRange(left),
    [c, d] = subnetRange(right);
  return a <= d && c <= b;
}
// 默认路由不表示池被占用；更具体的真实业务路由则必须拒绝碰撞。
export function selectTaskSubnet(
  networks: NetworkDescription[],
  hostRoutes: string[] = [],
): string {
  for (const route of hostRoutes) {
    z.cidrv4().parse(route);
    if (
      route !== "0.0.0.0/0" &&
      subnetsOverlap(route, TASK_ADDRESS_POOL) &&
      !networks.some(
        (network) =>
          network.Labels?.["relay-sandbox.task"] &&
          network.IPAM?.Config?.some((item) => item.Subnet === route),
      )
    ) {
      throw new Error(`任务专用地址池与宿主路由冲突：${route}`);
    }
  }
  const occupied: string[] = [];
  for (const network of networks)
    for (const item of network.IPAM?.Config ?? []) {
      if (!item.Subnet) continue;
      // Docker 可能同时列出 IPv6；本功能不会使用或开放这些地址。
      if (item.Subnet.includes(":")) continue;
      if (!subnetsOverlap(item.Subnet, TASK_ADDRESS_POOL)) continue;
      if (!network.Labels?.["relay-sandbox.task"])
        throw new Error(`任务专用地址池与无关网络冲突：${network.Id}`);
      occupied.push(item.Subnet);
    }
  for (const subnet of taskSubnetCandidates()) {
    if (!occupied.some((used) => subnetsOverlap(used, subnet))) return subnet;
  }
  throw new Error("任务专用地址池已耗尽");
}
// 每任务分配 /28，Docker 原子创建负责拒绝并发选择的同一网段。
export function* taskSubnetCandidates(): Generator<string> {
  for (let index = 0; index < 4096; index++)
    yield `198.19.${Math.floor(index / 16)}.${(index % 16) * 16}/28`;
}
// 只读取有任务标签的网络，不更新或删除无关 Docker 资源。
export async function collectTaskBoundaries(docker: {
  listNetworks(): Promise<NetworkDescription[]>;
}): Promise<TaskBoundary[]> {
  return (await docker.listNetworks()).flatMap((network) => {
    const ownerId = network.Labels?.["relay-sandbox.task"];
    if (!ownerId) return [];
    return (network.IPAM?.Config ?? []).flatMap((item) => {
      if (!item.Subnet) return [];
      z.cidrv4().parse(item.Subnet);
      return [{ networkId: network.Id, ownerId, subnet: item.Subnet }];
    });
  });
}
