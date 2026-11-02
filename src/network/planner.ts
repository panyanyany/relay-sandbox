import { z } from "zod";
import { networkGrantSchema } from "../permissions/schema.js";
import type { NetworkGrant } from "../permissions/types.js";
import { subnetRange, TASK_ADDRESS_POOL } from "./task-boundaries.js";

export interface NetworkPlanInput {
  mode: "legacy" | "default-open";
  subnet: string;
  gateway: string;
  hostAddresses: string[];
  otherTaskSubnets: string[];
  grants: NetworkGrant[];
}
// 保留旧任务私网禁止语义；新任务不引用这组地址作为一般内网禁令。
const legacyPrivateRanges =
  "0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4";
// 纯规划器只生成严格校验后的 nft 输入，不安装宿主防火墙。
export function planNetworkPolicy(input: NetworkPlanInput): string {
  if (!["legacy", "default-open"].includes(input.mode))
    throw new Error("网络模式非法");
  const [start, end] = subnetRange(input.subnet);
  const [poolStart, poolEnd] = subnetRange(TASK_ADDRESS_POOL);
  if (input.mode === "default-open" && (start < poolStart || end > poolEnd))
    throw new Error("新任务必须使用专用地址池");
  z.ipv4().parse(input.gateway);
  const gateway = input.gateway
    .split(".")
    .reduce((sum, part) => sum * 256 + Number(part), 0);
  if (gateway < start || gateway > end) throw new Error("网关不属于任务子网");
  const hosts = [...new Set([input.gateway, ...input.hostAddresses])];
  hosts.forEach((host) => z.ipv4().parse(host));
  input.otherTaskSubnets.forEach((subnet) => z.cidrv4().parse(subnet));
  const grants = input.grants.map((grant) => networkGrantSchema.parse(grant));
  if (input.mode === "legacy" && grants.length)
    throw new Error("旧任务不能隐式增加授权");
  const allow = grants.map((grant) => {
    const ports =
      grant.ports === "all" ? "" : ` dport { ${grant.ports.join(", ")} }`;
    const protocol =
      grant.protocol === "any"
        ? ""
        : grant.ports === "all"
          ? ` meta l4proto ${grant.protocol}`
          : ` ${grant.protocol}${ports}`;
    return `ip daddr ${grant.target}${protocol} accept`;
  });
  return [
    "table inet relay {",
    "chain output { type filter hook output priority 0; policy accept;",
    'oifname "lo" accept',
    "meta nfproto ipv6 reject",
    ...allow,
    ...hosts.map((host) => `ip daddr ${host} reject`),
    ...input.otherTaskSubnets.map((subnet) => `ip daddr ${subnet} reject`),
    `ip daddr ${input.subnet} accept`,
    `ip daddr ${TASK_ADDRESS_POOL} reject`,
    ...(input.mode === "legacy"
      ? [`ip daddr { ${legacyPrivateRanges} } reject`]
      : []),
    "}",
    "}",
  ].join("\n");
}
