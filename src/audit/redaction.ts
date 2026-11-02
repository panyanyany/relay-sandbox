// 仅用于展示脱敏；保留错误类型与调用栈，禁止输出已知凭据。
export function redact(text: string, secrets: string[] = []): string {
  let output = text;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    output = output.split(secret).join("[已脱敏]");
  // 固定诱饵原值即使嵌在更长文本中也需脱敏，不依赖私密清单或词边界。
  return output
    .replace(/RELAY_SANDBOX_FAKE_(?:AWS|OPENROUTER)_[a-f0-9]{64}/g, "[已脱敏]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[已脱敏]")
    .replace(
      /((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[已脱敏]",
    );
}

// 入口展示完整 cause 与 AggregateError，避免清理失败掩盖原始堆栈。
export function formatError(
  error: unknown,
  secrets: string[] = [],
  seen = new Set<unknown>(),
): string {
  if (seen.has(error)) return "[重复原因]";
  seen.add(error);
  if (!(error instanceof Error)) return redact(String(error), secrets);
  const parts = [error.stack ?? `${error.name}: ${error.message}`];
  if (error.cause)
    parts.push(`原因:\n${formatError(error.cause, secrets, seen)}`);
  if (error instanceof AggregateError)
    for (const child of error.errors)
      parts.push(formatError(child, secrets, seen));
  return redact(parts.join("\n"), secrets);
}
