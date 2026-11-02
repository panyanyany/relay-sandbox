import { expect, test } from "vitest";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { configSchema } from "../../src/config/schema.js";

// 默认不增加授权，也不改变旧项目网络字段的含义。
test("宿主授权独立、诱饵默认关闭且未知字段立即失败", () => {
  const value = hostPermissionsSchema.parse({});
  expect(value).toEqual({
    version: 1,
    network: { grants: [] },
    resources: [],
    decoys: { enabled: false, clients: [] },
  });
  expect(
    configSchema.parse({ network: { hostAddresses: ["10.0.0.1"] } }).network
      .hostAddresses,
  ).toEqual(["10.0.0.1"]);
  expect(() => configSchema.parse({ permissions: value })).toThrow();
  expect(() => hostPermissionsSchema.parse({ privileged: true })).toThrow();
  expect(() =>
    hostPermissionsSchema.parse({ decoys: { enabled: true, injectEnv: true } }),
  ).toThrow();
});

// 用户可显式授权整个网段或全部端口，但不得向规则中注入任意文本。
test("网络支持单地址、CIDR、指定端口和广泛范围", () => {
  const network = {
    grants: [
      { target: "10.1.2.3", ports: [443] },
      { target: "0.0.0.0/0", ports: "all", protocol: "any" },
    ],
  };
  expect(hostPermissionsSchema.parse({ network }).network.grants[0]).toEqual({
    target: "10.1.2.3",
    ports: [443],
    protocol: "tcp",
  });
  for (const grant of [
    { target: "10.0.0.1; accept", ports: "all" },
    { target: "10.0.0.0/33", ports: "all" },
    { target: "::1", ports: "all" },
    { target: "10.0.0.1", ports: [] },
    { target: "10.0.0.1", ports: [0] },
    { target: "10.0.0.1", ports: [65536] },
    { target: "10.0.0.1", ports: [443, 443] },
    { target: "10.0.0.1", ports: [443], protocol: "any" },
  ])
    expect(() =>
      hostPermissionsSchema.parse({ network: { grants: [grant] } }),
    ).toThrow();
});

// 资源声明只能描述受控文件模式，不能携带 Docker 的任意参数。
test("资源命名唯一、默认副本只读，拒绝歧义路径和任意权限", () => {
  const resource = {
    name: "cache",
    source: "/srv/cache",
    target: "/resources/cache",
  };
  expect(
    hostPermissionsSchema.parse({ resources: [resource] }).resources[0],
  ).toEqual({ ...resource, mode: "copy", access: "read-only" });
  expect(
    hostPermissionsSchema.parse({
      resources: [{ ...resource, mode: "direct", access: "read-write" }],
    }).resources[0]?.mode,
  ).toBe("direct");
  for (const resources of [
    [resource, resource],
    [{ ...resource, source: "relative" }],
    [{ ...resource, target: "/resources/../workspace" }],
    [{ ...resource, source: "/srv/cache\u0000bad" }],
    [{ ...resource, privileged: true }],
  ])
    expect(() => hostPermissionsSchema.parse({ resources })).toThrow();
});

// 兼容清单保存已验证组合，不将“Python”泛化成所有客户端均可解密。
test("开启诱饵仍需明确冻结客户端版本与信任配置", () => {
  const client = {
    id: "python-requests",
    tool: "python",
    version: "3.12.8",
    library: "requests@2.32.3",
    trustStore: "explicit-ca-file",
    invocation: ["python", "audited-request.py"],
  };
  const value = hostPermissionsSchema.parse({
    decoys: { enabled: true, clients: [client] },
  });
  expect(value.decoys.clients).toEqual([client]);
  for (const clients of [
    [{ ...client, version: "" }],
    [{ ...client, invocation: [] }],
    [client, client],
    [{ ...client, trustStore: "disable-verification" }],
  ])
    expect(() =>
      hostPermissionsSchema.parse({ decoys: { clients } }),
    ).toThrow();
});
