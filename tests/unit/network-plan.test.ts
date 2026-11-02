import { expect, test } from "vitest";
import {
  collectTaskBoundaries,
  selectTaskSubnet,
  TASK_ADDRESS_POOL,
} from "../../src/network/task-boundaries.js";
import { planNetworkPolicy } from "../../src/network/planner.js";
const base = {
  mode: "default-open" as const,
  subnet: "198.19.0.0/28",
  gateway: "198.19.0.1",
  hostAddresses: ["192.168.1.5"],
  otherTaskSubnets: ["172.30.0.0/24"],
  grants: [],
};

// 断言可执行规划的边界及顺序，不用不存在的外网服务证明阻断。
test("默认开放内网，但宿主及现在和未来的任务网络拒绝", () => {
  const script = planNetworkPolicy(base);
  expect(script).toContain("policy accept");
  expect(script).not.toContain("192.168.0.0/16");
  expect(script).toContain("ip daddr 192.168.1.5 reject");
  expect(script).toContain("ip daddr 172.30.0.0/24 reject");
  expect(script).toContain(`ip daddr ${TASK_ADDRESS_POOL} reject`);
  expect(script.indexOf(`ip daddr ${base.subnet} accept`)).toBeLessThan(
    script.indexOf(`ip daddr ${TASK_ADDRESS_POOL} reject`),
  );
  expect(script.indexOf("ip daddr 198.19.0.1 reject")).toBeLessThan(
    script.indexOf(`ip daddr ${base.subnet} accept`),
  );
  expect(script).toContain("meta nfproto ipv6 reject");
});
test("明确授权优先于宿主和跨任务拒绝，旧任务保留私网禁令", () => {
  const script = planNetworkPolicy({
    ...base,
    grants: [{ target: "192.168.0.0/16", ports: [443], protocol: "tcp" }],
  });
  expect(
    script.indexOf("ip daddr 192.168.0.0/16 tcp dport { 443 } accept"),
  ).toBeLessThan(script.indexOf("ip daddr 192.168.1.5 reject"));
  expect(() =>
    planNetworkPolicy({
      ...base,
      subnet: "172.20.0.0/24",
      gateway: "172.20.0.1",
    }),
  ).toThrow("专用地址池");
  const legacy = planNetworkPolicy({ ...base, mode: "legacy" });
  expect(legacy).toContain("192.168.0.0/16");
  expect(() => planNetworkPolicy({ ...base, subnet: "bad;accept" })).toThrow();
  expect(() => planNetworkPolicy({ ...base, gateway: "198.19.1.1" })).toThrow();
  expect(() =>
    planNetworkPolicy({
      ...base,
      grants: [{ target: "0.0.0.0/0", ports: "all", protocol: "any" }],
      mode: "legacy",
    }),
  ).toThrow();
});
test("保留池避开已有任务，无关网络或宿主路由碰撞明确失败", () => {
  const used = [
    {
      Id: "task",
      Labels: { "relay-sandbox.task": "old" },
      IPAM: { Config: [{ Subnet: "198.19.0.0/28" }] },
    },
  ];
  expect(selectTaskSubnet(used)).toBe("198.19.0.16/28");
  expect(() => selectTaskSubnet([{ ...used[0]!, Labels: {} }])).toThrow("冲突");
  expect(() => selectTaskSubnet([], ["198.19.0.0/24"])).toThrow("冲突");
  expect(selectTaskSubnet([], ["0.0.0.0/0", "192.168.1.0/24"])).toBe(
    "198.19.0.0/28",
  );
});
test("只收集有任务归属的Docker网络，不改变任何网络", async () => {
  const boundaries = await collectTaskBoundaries({
    listNetworks: async () => [
      {
        Id: "a",
        Labels: { "relay-sandbox.task": "one" },
        IPAM: { Config: [{ Subnet: "198.19.0.0/28" }] },
      },
      {
        Id: "b",
        Labels: { "relay-sandbox.task": "two" },
        IPAM: { Config: [{ Subnet: "172.30.0.0/24" }] },
      },
      {
        Id: "unrelated",
        Labels: {},
        IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] },
      },
    ],
  });
  expect(boundaries).toEqual([
    { networkId: "a", ownerId: "one", subnet: "198.19.0.0/28" },
    { networkId: "b", ownerId: "two", subnet: "172.30.0.0/24" },
  ]);
});
