import { expect, test } from "vitest";
import { reviewRecordSchema } from "../../src/sessions/review/state.js";
// 未完成不是批准；报告使用严格结构，不能夹带任意状态。
test("审查报告拒绝伪造状态", () => {
  expect(() => reviewRecordSchema.parse({ status: "approved" })).toThrow();
});
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { freezeEnvironment } from "../../src/tasks/environment.js";
import { writeJson } from "../../src/storage/files.js";
import { digest } from "../../src/storage/hash.js";
import { scan, manifestDigest } from "../../src/workspace/manifest.js";
import { saveTask } from "../../src/tasks/store.js";
import { readSessionState } from "../../src/sessions/state.js";
import {
  withSessionOperation,
  acquireSessionOperation,
  releaseSessionOperation,
} from "../../src/sessions/operation.js";
import { replaySessionEvents } from "../../src/sessions/event-store.js";
import { retrySessionReview } from "../../src/sessions/review/report.js";
import {
  listSessionReviews,
  sessionReviewStatus,
} from "../../src/sessions/review/state.js";
import { reviewConfigurationSchema } from "../../src/sessions/review/config.js";
import type { ReviewEvidence } from "../../src/sessions/review/evidence.js";
const configuration = reviewConfigurationSchema.parse({ profile: "review" });
async function fixture(
  run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "report-test-"));
  try {
    await run(await setup(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function setup(home: string) {
  const cwd = join(home, "project");
  await mkdir(cwd);
  const taskId = randomUUID();
  const session = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
    taskId,
    environmentId: taskId,
  });
  const project = configSchema.parse({});
  // 使用真实任务准备的冻结摘要，不能以项目配置摘要伪造验收夹具。
  const frozen = await freezeEnvironment(home, taskId, "test", project);
  await saveTask(home, {
    id: taskId,
    terminalSessionId: session.id,
    projectId: "test",
    projectRoot: cwd,
    prompt: "test",
    config: project,
    configDigest: frozen.configDigest,
    state: "prepared",
    round: 0,
    checks: [],
    warnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const id = randomUUID(),
    root = join(home, "sessions", session.id, "reviews", `v0-${id}`);
  const codePath = join(root, "code"),
    behaviorPath = join(root, "behavior.json");
  await mkdir(codePath, { recursive: true });
  await writeFile(join(codePath, "a.ts"), "a");
  await writeFile(behaviorPath, "{}");
  const manifest = await scan(codePath);
  const evidence: ReviewEvidence = {
    schemaVersion: 1,
    id,
    sessionId: session.id,
    taskId,
    evidenceVersion: 0,
    configDigest: frozen.configDigest,
    codeDigest: manifestDigest(manifest),
    logDigest: digest(digest("[]") + "{}"),
    createdAt: new Date().toISOString(),
    root,
    codePath,
    behaviorPath,
    gaps: ["日志缺失"],
  };
  await writeJson(join(root, "manifest.json"), evidence);
  await writeJson(join(root, "code-manifest.json"), manifest);
  const context = {
    configuration,
    project,
    key: "review-secret",
    profile: profileSchema.parse({
      endpoint: "http://localhost:1",
      model: "fake",
      protocol: "responses",
      apiKeyEnv: "REVIEW_KEY",
      image: `sha256:${"a".repeat(64)}`,
      networkImage: `sha256:${"a".repeat(64)}`,
    }),
  };
  const loadConfiguration = async () => context;
  const invoke = async () => {
    const decision = {
      schemaVersion: 1,
      taskId,
      artifactDigest: evidence.codeDigest,
      configDigest: evidence.configDigest,
      verdict: "approve",
      summary: "完成",
      findings: [],
    };
    return JSON.stringify({
      schemaVersion: 1,
      evidenceId: id,
      sessionId: session.id,
      evidenceVersion: 0,
      codeDigest: evidence.codeDigest,
      configDigest: evidence.configDigest,
      code: { status: "completed", decision },
      behavior: { status: "completed", decision },
    });
  };
  return { home, session, evidence, loadConfiguration, invoke };
}
test("补审保存历史、发送摘要事件且仅更新当前证据版本", async () =>
  fixture(async (f) => {
    const first = await retrySessionReview({ ...f, evidenceId: f.evidence.id });
    expect(first.record.execution.status).toBe("completed");
    expect((await readSessionState(f.home, f.session.id)).reviewedVersion).toBe(
      0,
    );
    expect(
      (await replaySessionEvents(f.home, f.session.id)).events.at(-1)?.type,
    ).toBe("review");
    await withSessionOperation(
      f.home,
      f.session.id,
      "development",
      async () => {},
    );
    await retrySessionReview({ ...f, evidenceId: f.evidence.id });
    const status = await sessionReviewStatus(f.home, f.session.id);
    expect(status.pending).toBe(true);
    expect(status.reviewedVersion).toBe(0);
    expect(status.reports).toHaveLength(2);
  }));
test("失败保留报告可重试，篡改证据与开发忙碌拒绝调用模型", async () =>
  fixture(async (f) => {
    const failed = await retrySessionReview({
      ...f,
      evidenceId: f.evidence.id,
      loadConfiguration: async () => {
        throw new Error("缺少配置");
      },
    });
    expect(failed.record.execution.status).toBe("incomplete");
    expect(await listSessionReviews(f.home, f.session.id)).toHaveLength(1);
    expect(
      (await readSessionState(f.home, f.session.id)).reviewedVersion,
    ).toBeUndefined();
    const lease = await acquireSessionOperation(
      f.home,
      f.session.id,
      "development",
    );
    try {
      await expect(
        retrySessionReview({ ...f, evidenceId: f.evidence.id }),
      ).rejects.toThrow("忙碌");
    } finally {
      await releaseSessionOperation(f.home, f.session.id, lease);
    }
    await writeFile(join(f.evidence.codePath, "a.ts"), "tampered");
    await expect(
      retrySessionReview({ ...f, evidenceId: f.evidence.id }),
    ).rejects.toThrow("摘要不符");
  }));

// 缺失或篡改冻结授权必须失败，不能退回当前宿主授权重新计算。
test.each(["missing", "changed"])("冻结授权%s时审查明确未完成", async (mode) =>
  fixture(async (f) => {
    const path = join(f.home, "tasks", f.evidence.taskId, "policy.json");
    if (mode === "missing") await rm(path);
    else {
      const { readFrozenPolicy } =
        await import("../../src/permissions/freeze.js");
      const policy = await readFrozenPolicy(f.home, f.evidence.taskId);
      await writeJson(path, {
        ...policy,
        network: {
          grants: [{ target: "192.0.2.1", ports: [443], protocol: "tcp" }],
        },
      });
    }
    const result = await retrySessionReview({
      ...f,
      evidenceId: f.evidence.id,
    });
    expect(result.record.execution.status).toBe("incomplete");
    expect(
      (await readSessionState(f.home, f.session.id)).reviewedVersion,
    ).not.toBe(0);
  }),
);
