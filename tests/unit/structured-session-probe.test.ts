import { describe, expect, it } from "vitest";
import { classifyStructuredEvidence } from "../../scripts/probe-structured-sessions.js";

describe("结构化能力证据", () => {
  it("不能把只有ID或退出0当作完成和可恢复", () => {
    expect(classifyStructuredEvidence({ id: "one", resumedId: "one", completed: false, priorContext: false })).toEqual({
      transport: true,
      completed: false,
      recovery: false,
    });
  });
  it("恢复必须同ID且真实请求携带前轮上下文", () => {
    expect(
      classifyStructuredEvidence({ id: "one", resumedId: "one", completed: true, priorContext: true }).recovery,
    ).toBe(true);
    expect(
      classifyStructuredEvidence({ id: "one", resumedId: "two", completed: true, priorContext: true }).recovery,
    ).toBe(false);
  });
});
