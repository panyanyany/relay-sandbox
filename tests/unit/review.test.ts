import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reviewSchema } from "../../src/agents/host/review-schema.js";
import { configSchema } from "../../src/config/schema.js";
import { reviewTask, applyTask } from "../../src/tasks/deliver.js";
import { saveTask, getTask } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";

// 真实持久化入口验证拒绝状态，而不是只检查 schema 的实现细节。
test("审核拒绝和待处理阻止应用，绑定摘要并拒绝非法格式", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-review-"));
  const task: Task = {
    id: "review-test",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "config",
    artifactDigest: "artifact",
    deliveryPrepared: true,
    state: "checking",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
  };
  const decision = {
    schemaVersion: 1,
    taskId: task.id,
    artifactDigest: "artifact",
    configDigest: "config",
    verdict: "approve",
    summary: "检查通过",
    findings: [],
  };
  try {
    await saveTask(home, task);
    for (const verdict of ["reject", "needs_attention"]) {
      expect(
        (await reviewTask(home, task.id, { ...decision, verdict })).state,
      ).toBe("blocked");
      await expect(applyTask(home, task.id)).rejects.toThrow("未满足交付条件");
    }
    for (const invalid of [
      "纯文字：通过",
      { ...decision, verdict: "pass" },
      { ...decision, summary: " " },
      { ...decision, extra: true },
      { accepted: true, reason: "旧格式" },
    ]) {
      await expect(reviewTask(home, task.id, invalid)).rejects.toThrow();
      expect((await getTask(home, task.id)).state).toBe("blocked");
    }
    await expect(
      reviewTask(home, task.id, { ...decision, artifactDigest: "old" }),
    ).rejects.toThrow("过期");
    expect((await reviewTask(home, task.id, decision)).state).toBe("ready");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("问题必须提供分类和证据，重复编号及高风险批准被拒绝", () => {
  const finding = {
    id: "F1",
    category: "data_exfiltration",
    severity: "critical",
    file: "client.cjs",
    line: 2,
    description: "读取并上传假凭据",
    evidence: "readFileSync 与 fetch",
    recommendation: "删除上传逻辑",
  };
  const report = {
    schemaVersion: 1,
    taskId: "t",
    artifactDigest: "a",
    configDigest: "c",
    verdict: "reject",
    summary: "发现外传",
    findings: [finding],
  };
  expect(reviewSchema.parse(report).findings[0]?.category).toBe(
    "data_exfiltration",
  );
  expect(() => reviewSchema.parse({ ...report, verdict: "approve" })).toThrow(
    "高风险",
  );
  expect(() =>
    reviewSchema.parse({ ...report, findings: [finding, finding] }),
  ).toThrow("重复");
  expect(() =>
    reviewSchema.parse({ ...report, findings: [{ ...finding, evidence: "" }] }),
  ).toThrow();
});
