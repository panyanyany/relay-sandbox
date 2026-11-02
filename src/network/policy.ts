import { networkInterfaces } from "node:os";
import { hostAddresses } from "./host-addresses.js";
import type { RuntimeOptions } from "../permissions/types.js";
import { collectTaskBoundaries } from "./task-boundaries.js";
import { planNetworkPolicy } from "./planner.js";
import { withFinalizer } from "../storage/finalize.js";
import type Docker from "dockerode";

// 策略装在任务网络命名空间内，开发进程无法修改，不触碰宿主防火墙。
export function policyScript(
  subnet: string,
  gateway: string,
  additionalHosts: string[] = [],
): string {
  return planNetworkPolicy({
    mode: "legacy",
    subnet,
    gateway,
    hostAddresses: [
      ...additionalHosts,
      ...Object.values(networkInterfaces()).flatMap((list) =>
        (list ?? [])
          .filter((a) => a.family === "IPv4" && !a.internal)
          .map((a) => a.address),
      ),
    ],
    otherTaskSubnets: [],
    grants: [],
  });
}
// 临时可信辅助容器只有任务网络管理权限，退出后销毁；开发容器始终 CapDrop ALL。
export async function installPolicy(
  docker: Docker,
  containerId: string,
  networkId: string,
  image: string,
  extraHosts: string[] = [],
  network?: RuntimeOptions["network"],
): Promise<void> {
  const info = await docker.getNetwork(networkId).inspect();
  const ipam = info.IPAM?.Config?.[0];
  if (!ipam?.Subnet || !ipam.Gateway) throw new Error("无法取得任务网络边界");
  const owner = info.Labels?.["relay-sandbox.task"];
  if (!owner) throw new Error("任务网络缺少归属标签");
  const addresses = [...(await hostAddresses()), ...extraHosts];
  const boundaries = await collectTaskBoundaries({
    listNetworks: () => docker.listNetworks(),
  });
  const rules = planNetworkPolicy({
    mode: network?.mode ?? "legacy",
    subnet: ipam.Subnet,
    gateway: ipam.Gateway,
    hostAddresses: addresses,
    otherTaskSubnets: boundaries
      .filter((item) => item.ownerId !== owner)
      .map((item) => item.subnet),
    grants: network?.grants ?? [],
  });
  const helper = await docker.createContainer({
    Image: image,
    User: "0:0",
    Cmd: [
      "sh",
      "-ec",
      `{ if nft list table inet relay >/dev/null 2>&1; then printf 'delete table inet relay\\n'; fi; printf '%s' "$RELAY_RULES"; } | nft -f -`,
    ],
    Env: [`RELAY_RULES=${rules}`],
    HostConfig: {
      NetworkMode: `container:${containerId}`,
      CapDrop: ["ALL"],
      CapAdd: ["NET_ADMIN"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
    },
    // 辅助容器也归属任务，异常中断后可由统一清理器回收。
    Labels: {
      "relay-sandbox.kind": "network-helper",
      "relay-sandbox.task": owner,
    },
  });
  await withFinalizer(
    async () => {
      await helper.start();
      const exit = await helper.wait();
      if (exit.StatusCode !== 0)
        throw new Error("任务网络规则安装失败，拒绝启动 Agent");
    },
    () => helper.remove({ force: true }).then(() => undefined),
  );
}
