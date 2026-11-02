import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";

// 项目只能申请命名资源，不能在申请中夹带宿主路径或放行规则。
test("项目可声明命名资源需求，但不能自行携带授权", () => {
  expect(configSchema.parse({}).resourceRequests).toEqual([]);
  expect(
    configSchema.parse({ resourceRequests: ["cache"] }).resourceRequests,
  ).toEqual(["cache"]);
  expect(() =>
    configSchema.parse({
      resourceRequests: [{ name: "cache", source: "/home/user" }],
    }),
  ).toThrow();
  expect(() =>
    configSchema.parse({ resourceRequests: ["cache", "cache"] }),
  ).toThrow();
  expect(() =>
    configSchema.parse({
      permissions: {
        network: { grants: [{ target: "0.0.0.0/0", ports: "all" }] },
      },
    }),
  ).toThrow();
});
