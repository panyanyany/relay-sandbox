import { expect, test } from "vitest";
import { classifyLifecycleGate } from "../../scripts/probe-native-lifecycle.js";

// 错误示范：没有模型调用不代表没有执行本地命令，必须检查实际副作用。
test("命令绕过拒绝钩子时，不能把零模型调用判断为准入可靠", () => {
  expect(
    classifyLifecycleGate({ marker: true, hooks: [], modelRequests: 0 }),
  ).toBe("bypassed");
  expect(
    classifyLifecycleGate({
      marker: true,
      hooks: ["PreToolUse"],
      modelRequests: 0,
    }),
  ).toBe("bypassed");
});

test("没有实际执行或阻断证据时，保持未知而非通过", () => {
  expect(
    classifyLifecycleGate({ marker: false, hooks: [], modelRequests: 0 }),
  ).toBe("unknown");
  expect(
    classifyLifecycleGate({
      marker: false,
      hooks: ["PreToolUse"],
      modelRequests: 0,
    }),
  ).toBe("unknown");
  expect(
    classifyLifecycleGate({
      marker: false,
      hooks: ["PreToolUse"],
      modelRequests: 1,
    }),
  ).toBe("bypassed");
});
