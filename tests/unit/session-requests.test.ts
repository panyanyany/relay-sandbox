import { describe, expect, it } from "vitest";
import {
  executableSessionRequestSchema,
  readonlySessionRequestSchema,
} from "../../src/sessions/requests.js";
import { sessionCapabilitiesSchema } from "../../src/sessions/capabilities.js";

describe("统一会话请求边界", () => {
  it("保留消息和技能参数的原文，JSON往返不改变执行语义", () => {
    for (const request of [
      { type: "message", prompt: "  修复问题\n保留格式  " },
      { type: "skill", name: "team/review-code", args: "路径含空格 --检查" },
      { type: "skill", name: "review_code.v2" },
    ]) {
      expect(
        executableSessionRequestSchema.parse(
          JSON.parse(JSON.stringify(request)),
        ),
      ).toEqual(request);
    }
  });

  it.each([
    { type: "message", prompt: "   \n" },
    { type: "message", prompt: "x".repeat(65537) },
    { type: "message", prompt: "ok", shell: true },
    { type: "skill", name: "../private" },
    { type: "skill", name: "team//skill" },
    { type: "skill", name: "name;curl" },
    { type: "skill", name: "" },
    { type: "skill", name: "x".repeat(257) },
    { type: "skill", name: "review", args: "x".repeat(65537) },
    { type: "skill", name: "review", args: [] },
    { type: "shell", command: "pwd" },
  ])("拒绝无效执行输入 %#", (request) => {
    expect(executableSessionRequestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it("只读查询不混入可执行请求或未知字段", () => {
    expect(readonlySessionRequestSchema.parse({ type: "skills" })).toEqual({
      type: "skills",
    });
    expect(
      readonlySessionRequestSchema.parse({ type: "capabilities" }),
    ).toEqual({ type: "capabilities" });
    expect(
      readonlySessionRequestSchema.safeParse({
        type: "skills",
        prompt: "execute",
      }).success,
    ).toBe(false);
    expect(
      executableSessionRequestSchema.safeParse({ type: "skills" }).success,
    ).toBe(false);
    expect(
      readonlySessionRequestSchema.safeParse({ type: "message", prompt: "hi" })
        .success,
    ).toBe(false);
  });

  it("分别声明技能发现与调用支持，缺能力必须说明原因", () => {
    const value = {
      skills: {
        list: { status: "supported" },
        invoke: { status: "unsupported", reason: "结构化接口未提供原生调用" },
      },
    };
    expect(sessionCapabilitiesSchema.parse(value)).toEqual(value);
    expect(
      sessionCapabilitiesSchema.safeParse({
        skills: {
          list: { status: "unsupported" },
          invoke: { status: "supported" },
        },
      }).success,
    ).toBe(false);
    expect(
      sessionCapabilitiesSchema.safeParse({
        skills: {
          list: { status: "supported", reason: "猜测" },
          invoke: { status: "supported" },
        },
      }).success,
    ).toBe(false);
  });
});
