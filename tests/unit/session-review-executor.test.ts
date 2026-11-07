import { expect, test } from "vitest";
import { reviewConfigurationSchema } from "../../src/sessions/review/config.js";

// 审查角色必须显式使用专用档案，不能悄悄借用开发档案。
test("独立审查默认 Codex，但要求显式档案", () => {
  expect(
    reviewConfigurationSchema.parse({ profile: "review-only" }).agent,
  ).toBe("codex");
  expect(() => reviewConfigurationSchema.parse({})).toThrow();
  expect(() =>
    reviewConfigurationSchema.parse({ profile: "../development" }),
  ).toThrow();
});

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { executeReview } from "../../src/sessions/review/executor.js";
import { reviewLaunch, reviewOutput } from "../../src/sessions/review/cli.js";
import type { ReviewEvidence } from "../../src/sessions/review/evidence.js";
import type { ReviewContext } from "../../src/sessions/review/config.js";

const context: ReviewContext = {
  configuration: reviewConfigurationSchema.parse({ profile: "review-only" }),
  profile: profileSchema.parse({
    endpoint: "http://localhost:9999",
    model: "test",
    apiKeyEnv: "REVIEW_KEY",
    protocol: "responses",
    image: `sha256:${"a".repeat(64)}`,
    networkImage: `sha256:${"b".repeat(64)}`,
  }),
  key: "private-review-key",
  project: configSchema.parse({}),
};
async function fixture(run: (e: ReviewEvidence) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "review-test-"));
  try {
    await mkdir(join(root, "code"));
    await mkdir(join(root, "logs"));
    await writeFile(join(root, "code", "a.ts"), "export const a = 1;");
    await writeFile(join(root, "behavior.json"), "{}");
    await run({
      schemaVersion: 1,
      id: "e",
      sessionId: "s",
      taskId: "t",
      evidenceVersion: 1,
      codeDigest: "code",
      configDigest: "config",
      logDigest: "log",
      createdAt: "",
      root,
      codePath: join(root, "code"),
      behaviorPath: join(root, "behavior.json"),
      gaps: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function result(e: ReviewEvidence) {
  const decision = {
    schemaVersion: 1,
    taskId: e.taskId,
    artifactDigest: e.codeDigest,
    configDigest: e.configDigest,
    verdict: "approve",
    summary: "已审查",
    findings: [],
  };
  return {
    schemaVersion: 1,
    evidenceId: e.id,
    sessionId: e.sessionId,
    evidenceVersion: e.evidenceVersion,
    codeDigest: e.codeDigest,
    configDigest: e.configDigest,
    code: { status: "completed", decision },
    behavior: { status: "completed", decision },
  };
}
test("一次调用严格绑定两轴，行为提醒不会否决代码", async () =>
  fixture(async (e) => {
    const value = result(e);
    value.behavior.decision.verdict = "needs_attention";
    const response = await executeReview(e, context, {
      invoke: async (prompt) => {
        expect(prompt).toContain("不可信材料");
        return JSON.stringify(value);
      },
    });
    expect(response.status).toBe("completed");
    const mismatch = await executeReview(e, context, {
      invoke: async () => JSON.stringify({ ...value, codeDigest: "stale" }),
    });
    expect(mismatch.status).toBe("incomplete");
  }));
test("全部关闭不调用模型，配置检查却无执行器明确失败", async () =>
  fixture(async (e) => {
    const disabled = {
      ...context,
      configuration: { ...context.configuration, runtimeReview: false },
      project: configSchema.parse({ delivery: { aiReview: false } }),
    };
    expect(
      (
        await executeReview(e, disabled, {
          invoke: async () => {
            throw new Error("不应调用");
          },
        })
      ).status,
    ).toBe("skipped");
    const check = {
      ...disabled,
      project: configSchema.parse({
        delivery: {
          aiReview: false,
          checks: [{ name: "test", argv: ["test"] }],
        },
      }),
    };
    expect((await executeReview(e, check)).status).toBe("incomplete");
  }));
test("非法结果、超时和鉴权错误均未完成且诊断脱敏", async () =>
  fixture(async (e) => {
    for (const invoke of [
      async () => "not JSON",
      async () => {
        throw new Error(`auth failed ${context.key}`);
      },
      async () => {
        throw new Error("timeout");
      },
    ]) {
      const response = await executeReview(e, context, { invoke });
      expect(response.status).toBe("incomplete");
      expect(JSON.stringify(response)).not.toContain(context.key);
    }
  }));
test("真正CLI启动隔离宿主环境，密钥不入argv，无危险跳过", () => {
  process.env.RELAY_TEST_DEV_KEY = "development-secret";
  try {
    for (const [agent, protocol] of [
      ["codex", "responses"],
      ["claude-code", "anthropic"],
      ["opencode", "openai-compatible"],
    ] as const) {
      const launch = reviewLaunch(
        {
          ...context,
          configuration: { ...context.configuration, agent },
          profile: { ...context.profile, protocol },
        },
        "/isolated",
      );
      expect(JSON.stringify(launch.args)).not.toContain(context.key);
      expect(JSON.stringify(launch.args)).not.toContain("dangerously");
      expect(launch.env.RELAY_TEST_DEV_KEY).toBeUndefined();
      expect(launch.env.HOME).toBe("/isolated");
    }
  } finally {
    delete process.env.RELAY_TEST_DEV_KEY;
  }
  expect(() => reviewOutput("codex", '{"type":"turn.failed"}')).toThrow();
  expect(() =>
    reviewOutput(
      "claude-code",
      '{"type":"result","is_error":true,"result":"approve"}',
    ),
  ).toThrow();
});

import { runReviewCli } from "../../src/sessions/review/cli.js";
import { chmod } from "node:fs/promises";
// 合成可执行文件验证真实spawn/stdin/退出/超时，不访问模型。
test("审查CLI实际子进程处理stdin、非零退出和超时", async () =>
  fixture(async (e) => {
    const bin = join(e.root, "bin");
    await mkdir(bin);
    const command = join(bin, "codex");
    const original = process.env.PATH;
    process.env.PATH = bin;
    try {
      await writeFile(
        command,
        `#!${process.execPath}\nlet s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:s}})));`,
      );
      await chmod(command, 0o700);
      expect(await runReviewCli("stdin evidence", e, context)).toBe(
        "stdin evidence",
      );
      await writeFile(
        command,
        `#!${process.execPath}\nprocess.stderr.write('auth rejected');process.exit(7);`,
      );
      await expect(runReviewCli("x", e, context)).rejects.toThrow("退出7");
      // Codex 的鉴权错误在 stdout JSONL，stderr 可能只有不相关警告。
      await writeFile(
        command,
        `#!${process.execPath}\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'successful-body-not-an-error'}}));console.log(JSON.stringify({type:'turn.failed',error:{message:'401 Unauthorized '+process.env.RELAY_REVIEW_API_KEY}}));console.error('optional warning');process.exit(1);`,
      );
      await expect(runReviewCli("x", e, context)).rejects.toThrow(
        "401 Unauthorized",
      );
      try {
        await runReviewCli("x", e, context);
      } catch (error) {
        expect(String(error)).toContain("退出1");
        expect(String(error)).toContain("optional warning");
        expect(String(error)).not.toContain("successful-body-not-an-error");
        expect(String(error)).not.toContain(context.key);
      }
      await writeFile(
        command,
        `#!${process.execPath}\nsetInterval(()=>{},1000);`,
      );
      await expect(
        runReviewCli("x", e, {
          ...context,
          configuration: { ...context.configuration, timeoutMs: 100 },
        }),
      ).rejects.toThrow("超时");
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  }));

import { loadReviewConfiguration } from "../../src/sessions/review/config.js";
import { saveCredential } from "../../src/config/credentials.js";
test("可信宿主独立配置读取凭据，拒绝借用开发档案或相同密钥", async () => {
  const home = await mkdtemp(join(tmpdir(), "review-config-"));
  try {
    await mkdir(join(home, "profiles"));
    const profile = { ...context.profile, apiKeyEnv: "REVIEW_UNIT_KEY" };
    await writeFile(
      join(home, "profiles", "review-only.yaml"),
      JSON.stringify(profile),
    );
    await writeFile(
      join(home, "profiles", "relay-default.yaml"),
      JSON.stringify({ ...profile, apiKeyEnv: "DEV_UNIT_KEY" }),
    );
    await saveCredential(home, "REVIEW_UNIT_KEY", "review-unit-secret");
    await saveCredential(home, "DEV_UNIT_KEY", "dev-unit-secret");
    await expect(
      loadReviewConfiguration(home, context.project),
    ).rejects.toThrow();
    await writeFile(join(home, "review.yaml"), '{"profile":"review-only"}');
    expect((await loadReviewConfiguration(home, context.project)).key).toBe(
      "review-unit-secret",
    );
    await saveCredential(home, "REVIEW_UNIT_KEY", "dev-unit-secret");
    await expect(
      loadReviewConfiguration(home, context.project),
    ).rejects.toThrow("密钥必须分离");
    await writeFile(join(home, "review.yaml"), '{"profile":"relay-default"}');
    await expect(
      loadReviewConfiguration(home, context.project),
    ).rejects.toThrow("独立档案");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  ["codex", { type: "error", message: `401 Unauthorized ${context.key}` }],
  [
    "codex",
    {
      type: "turn.failed",
      error: { message: `401 Unauthorized ${context.key}` },
    },
  ],
  [
    "claude-code",
    {
      type: "result",
      is_error: true,
      errors: [`401 Unauthorized ${context.key}`],
    },
  ],
  [
    "opencode",
    {
      type: "error",
      error: { data: { message: `401 Unauthorized ${context.key}` } },
    },
  ],
] as const)("%s零退出错误事件保留原因且脱敏", (agent, event) => {
  expect(() =>
    reviewOutput(agent, JSON.stringify(event), [context.key]),
  ).toThrow("401 Unauthorized");
  try {
    reviewOutput(agent, JSON.stringify(event), [context.key]);
  } catch (error) {
    expect(String(error)).not.toContain(context.key);
  }
});
