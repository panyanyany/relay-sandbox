import { expect, test } from "vitest";
import { formatError, redact } from "../../src/audit/redaction.js";

// 即使投放清单已删除，普通输出里的固定格式诱饵仍应脱敏。
test("裸 AWS 和 OpenRouter 假凭据在 stdout 中不泄漏", () => {
  for (const provider of ["AWS", "OPENROUTER"]) {
    const value = `RELAY_SANDBOX_FAKE_${provider}_${"a".repeat(64)}`;
    expect(redact(`读取结果：\n${value}\n安装结束`).includes(value)).toBe(
      false,
    );
    expect(
      redact(`读取结果：\n${value}\n安装结束`) ===
        "读取结果：\n[已脱敏]\n安装结束",
    ).toBe(true);
    expect(
      redact(`(${value}), \"${value}\"`) === '([已脱敏]), "[已脱敏]"',
    ).toBe(true);
  }
});

// 脱敏不吞掉错误、cause 或堆栈，保留定位问题所需的非敏感内容。
test("异常和嵌套原因中的诱饵脱敏，错误类型及调用栈仍在", () => {
  const value = `RELAY_SANDBOX_FAKE_AWS_${"b".repeat(64)}`;
  const cause = new Error(`响应含 ${value}`);
  const error = new AggregateError([cause], `安装失败 ${value}`, { cause });
  const output = formatError(error);
  expect(output.includes(value)).toBe(false);
  expect(output).toContain("AggregateError: 安装失败 [已脱敏]");
  expect(output).toContain("Error: 响应含 [已脱敏]");
  expect(output).toContain("decoy-redaction.test.ts");
});

// 相似普通文本或格式不符的值不作为这一条规则的凭据处理。
test("严格格式之外的相似文本保持原样", () => {
  for (const value of [
    `RELAY_SANDBOX_FAKE_AWS_${"a".repeat(63)}`,
    `RELAY_SANDBOX_FAKE_AWS_${"A".repeat(64)}`,
    `RELAY_SANDBOX_FAKE_OTHER_${"a".repeat(64)}`,
    "安装失败 ENOENT /workspace/package.json",
  ])
    expect(redact(value)).toBe(value);
});

// 固定原值嵌入标识符、较长十六进制文本或相邻原值时，仍属于已知泄漏。
test("完整假凭据不因相邻字符而绕过脱敏", () => {
  for (const provider of ["AWS", "OPENROUTER"]) {
    const value = `RELAY_SANDBOX_FAKE_${provider}_${"c".repeat(64)}`;
    for (const input of [
      `PREFIX_${value}`,
      `${value}_SUFFIX`,
      `PREFIX_${value}_SUFFIX`,
      `${value}a`,
      `f${value}${"d".repeat(64)}`,
      `${value}${value}`,
    ])
      expect(redact(input).includes(value)).toBe(false);
  }
});

// 各错误分支必须同样去除嵌入原值，保留堆栈与非敏感上下文。
test("嵌入假凭据的堆栈、cause 和聚合子错误均脱敏", () => {
  const value = `RELAY_SANDBOX_FAKE_OPENROUTER_${"e".repeat(64)}`;
  const cause = new Error(`原因 PREFIX_${value}_SUFFIX`);
  const child = new Error(`子错误 ${value}f`);
  child.stack = `Error: 子错误 PREFIX_${value}_SUFFIX\n    at fixture-child:7`;
  const error = new AggregateError([child], `聚合 PREFIX_${value}`, { cause });
  const output = formatError(error);
  expect(output.includes(value)).toBe(false);
  expect(output).toContain("AggregateError: 聚合 PREFIX_[已脱敏]");
  expect(output).toContain("原因 PREFIX_[已脱敏]_SUFFIX");
  expect(output).toContain("子错误 PREFIX_[已脱敏]_SUFFIX");
  expect(output).toContain("at fixture-child:7");
  expect(output).toContain("decoy-redaction.test.ts");
});
