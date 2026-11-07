import { expect, it } from "vitest";
import { jsonSessionInputSchema } from "../../src/sessions/json-protocol.js";
it("接受旧消息、类型请求和只读查询，拒绝混合载荷", () => {
  for (const value of [
    { prompt: "hello" },
    { request: { type: "skill", name: "test" } },
    { command: "skills" },
  ])
    expect(jsonSessionInputSchema.safeParse(value).success).toBe(true);
  expect(
    jsonSessionInputSchema.safeParse({ prompt: "x", command: "help" }).success,
  ).toBe(false);
});
