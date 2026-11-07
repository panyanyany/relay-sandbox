import { expect, test } from "vitest";
import { classifyClaudeProbe } from "../../scripts/probe-native-sessions.js";

// 错误示范：原生 CLI 返回 0/success，并不意味着提示经过准入或模型已执行。
test("钩子阻断必须由明确通知、钩子记录和零请求共同证明", () => {
  const output = [
    { type: "system", subtype: "informational", prevent_continuation: true },
    { type: "result", subtype: "success", is_error: false, num_turns: 0 },
  ];
  expect(
    classifyClaudeProbe(
      output,
      [{ hook_event_name: "UserPromptSubmit", session_id: "native" }],
      0,
    ),
  ).toEqual({ blocked: true, nativeId: "native", modelRequests: 0 });
  expect(classifyClaudeProbe(output, [], 0).blocked).toBe(false);
  expect(
    classifyClaudeProbe(
      output,
      [{ hook_event_name: "UserPromptSubmit", session_id: "native" }],
      1,
    ).blocked,
  ).toBe(false);
});

test("普通成功结果和帮助输出不能冒充准入能力证据", () => {
  expect(
    classifyClaudeProbe([{ type: "result", subtype: "success" }], [], 0)
      .blocked,
  ).toBe(false);
  expect(
    classifyClaudeProbe(
      [],
      [{ hook_event_name: "Stop", session_id: "other" }],
      0,
    ).nativeId,
  ).toBeNull();
});
