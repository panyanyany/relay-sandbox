import { expect, test } from "vitest";
import {
  configSchema,
  profileSchema,
  type Profile,
} from "../../src/config/schema.js";
import { developmentAdapter } from "../../src/agents/development/adapters.js";
import { isReady } from "../../src/delivery/policy.js";
import { redact } from "../../src/audit/redaction.js";
import type { Task } from "../../src/tasks/types.js";
// 最小任务只包含策略实际依赖的数据，避免把容器实现带入纯函数测试。
function task(): Task {
  return {
    id: "t",
    projectId: "p",
    projectRoot: "/p",
    prompt: "x",
    config: configSchema.parse({}),
    configDigest: "c",
    state: "checking",
    createdAt: "",
    updatedAt: "",
    round: 1,
    artifactDigest: "a",
    deliveryPrepared: true,
    checks: [],
    warnings: [],
  };
}
test("默认双侧 Codex 且仅 AI 审查，拒绝未知权限字段", () => {
  const config = configSchema.parse({});
  expect(config.hostAgent.type).toBe("codex");
  expect(config.developmentAgent.type).toBe("codex");
  expect(config.delivery.aiReview).toBe(true);
  expect(config.delivery.checks).toEqual([]);
  expect(() => configSchema.parse({ privileged: true })).toThrow();
  expect(() => profileSchema.parse({ image: "latest" })).toThrow();
});
test("关闭检查可直接放行，旧结论和失败测试不放行", () => {
  const value = task();
  expect(isReady(value)).toBe(false);
  value.config.delivery.aiReview = false;
  expect(isReady(value)).toBe(true);
  value.config.delivery.aiReview = true;
  value.review = {
    taskId: "t",
    artifactDigest: "a",
    configDigest: "c",
    schemaVersion: 1,
    verdict: "approve",
    findings: [],
    summary: "ok",
  };
  expect(isReady(value)).toBe(true);
  value.artifactDigest = "b";
  expect(isReady(value)).toBe(false);
  value.artifactDigest = "a";
  value.config.delivery.checks = [{ name: "test", argv: ["true"] }];
  expect(isReady(value)).toBe(false);
  value.checks = [
    {
      name: "test",
      status: "failed",
      artifactDigest: "a",
      exitCode: 1,
      output: "",
    },
  ];
  expect(isReady(value)).toBe(false);
});
test("三种开发适配协议分开，密钥不会出现在 argv", () => {
  const base = {
    endpoint: "https://relay.example/v1",
    model: "test",
    apiKeyEnv: "TEST_KEY",
    image: `sha256:${"a".repeat(64)}`,
    networkImage: `sha256:${"a".repeat(64)}`,
  };
  for (const [type, protocol] of [
    ["codex", "responses"],
    ["claude-code", "anthropic"],
    ["opencode", "openai-compatible"],
  ] as const) {
    const profile: Profile = { ...base, protocol };
    const launch = developmentAdapter(type).launch(
      "task",
      profile,
      "fake-secret",
    );
    expect(launch.argv.join(" ")).not.toContain("fake-secret");
    expect(JSON.stringify(launch.env)).toContain("fake-secret");
  }
  expect(() =>
    developmentAdapter("codex").launch(
      "x",
      { ...base, protocol: "anthropic" },
      "key",
    ),
  ).toThrow("Responses");
});
test("日志脱敏替换专用密钥和 Bearer", () => {
  expect(
    redact("fake-secret Bearer abcdef123456", ["fake-secret"]),
  ).not.toContain("fake-secret");
  expect(redact("Bearer abcdef123456")).not.toContain("abcdef123456");
});

test("重复检查名称和 URL 内嵌凭据立即报错", () => {
  expect(() =>
    configSchema.parse({
      delivery: {
        checks: [
          { name: "unit", argv: ["true"] },
          { name: "unit", argv: ["false"] },
        ],
      },
    }),
  ).toThrow("名称不可重复");
  const image = `sha256:${"a".repeat(64)}`;
  expect(() =>
    profileSchema.parse({
      endpoint: "https://user:secret@relay.example/v1",
      model: "m",
      protocol: "responses",
      apiKeyEnv: "FAKE_KEY",
      image,
      networkImage: image,
    }),
  ).toThrow("内嵌凭据");
});
