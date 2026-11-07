import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../../storage/files.js";
import { digest } from "../../storage/hash.js";
import { scan, manifestDigest } from "../../workspace/manifest.js";
import { readSessionState } from "../state.js";
import { sessionReviewSchema } from "./executor.js";

export const reviewEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    sessionId: z.uuid(),
    taskId: z.uuid(),
    evidenceVersion: z.number().int().nonnegative(),
    configDigest: z.string().min(1),
    codeDigest: z.string().min(1),
    logDigest: z.string().min(1),
    createdAt: z.iso.datetime(),
    root: z.string(),
    codePath: z.string(),
    behaviorPath: z.string(),
    gaps: z.array(z.string()),
  })
  .strict();
const executionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      result: sessionReviewSchema,
      checks: z.array(z.json()),
    })
    .strict(),
  z
    .object({
      status: z.literal("skipped"),
      result: sessionReviewSchema,
      checks: z.array(z.json()),
    })
    .strict(),
  z
    .object({ status: z.literal("incomplete"), diagnostic: z.string() })
    .strict(),
]);
export const reviewRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    evidence: reviewEvidenceSchema,
    execution: executionSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.execution.status === "incomplete") return;
    const result = record.execution.result,
      evidence = record.evidence;
    if (
      result.evidenceId !== evidence.id ||
      result.sessionId !== evidence.sessionId ||
      result.evidenceVersion !== evidence.evidenceVersion ||
      result.codeDigest !== evidence.codeDigest ||
      result.configDigest !== evidence.configDigest
    )
      ctx.addIssue({ code: "custom", message: "报告结果与证据绑定不符" });
    for (const axis of [result.code, result.behavior])
      if (
        axis.status === "completed" &&
        (axis.decision.taskId !== evidence.taskId ||
          axis.decision.artifactDigest !== evidence.codeDigest ||
          axis.decision.configDigest !== evidence.configDigest)
      )
        ctx.addIssue({ code: "custom", message: "报告结论与证据绑定不符" });
    if (
      record.execution.status === "skipped" &&
      (result.code.status !== "skipped" || result.behavior.status !== "skipped")
    )
      ctx.addIssue({ code: "custom", message: "未执行报告不能包含已完成结论" });
  });
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export function reviewDirectory(home: string, sessionId: string) {
  return join(home, "sessions", z.uuid().parse(sessionId), "reviews");
}
async function directories(home: string, sessionId: string) {
  try {
    return (await readdir(reviewDirectory(home, sessionId))).filter((name) =>
      /^v\d+-[a-f0-9-]{36}$/.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
// 补审只从本会话固定目录找证据，不接受调用方传入任意路径。
export async function readReviewEvidence(
  home: string,
  sessionId: string,
  evidenceId: string,
) {
  z.uuid().parse(evidenceId);
  const matches = (await directories(home, sessionId)).filter((name) =>
    name.endsWith(`-${evidenceId}`),
  );
  if (matches.length !== 1) throw new Error("固定审查证据不存在或不唯一");
  const root = join(reviewDirectory(home, sessionId), matches[0]!);
  const evidence = reviewEvidenceSchema.parse(
    await readJson(join(root, "manifest.json")),
  );
  if (
    evidence.sessionId !== sessionId ||
    evidence.id !== evidenceId ||
    evidence.root !== root ||
    evidence.codePath !== join(root, "code") ||
    evidence.behaviorPath !== join(root, "behavior.json")
  )
    throw new Error("审查证据路径或身份绑定不符");
  if (
    manifestDigest(await scan(evidence.codePath)) !== evidence.codeDigest ||
    digest(JSON.stringify(await readJson(join(root, "code-manifest.json")))) !==
      evidence.codeDigest
  )
    throw new Error("固定代码证据摘要不符");
  const entries: { path: string; hash: string }[] = [];
  async function visit(relative: string) {
    const path = join(root, "logs", relative);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error("固定日志证据含非普通文件");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(join(relative, name));
    } else
      entries.push({
        path: relative,
        hash: digest(await readFile(path, "utf8")),
      });
  }
  try {
    const names = await readdir(join(root, "logs"));
    if (
      names.some(
        (name) =>
          !["audit.jsonl", "session-evidence.json", "telemetry"].includes(name),
      )
    )
      throw new Error("固定日志证据包含未绑定文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of ["audit.jsonl", "session-evidence.json", "telemetry"])
    await visit(name);
  const behavior = JSON.stringify(await readJson(evidence.behaviorPath));
  if (digest(digest(JSON.stringify(entries)) + behavior) !== evidence.logDigest)
    throw new Error("固定行为证据摘要不符");
  return evidence;
}
export async function listSessionReviews(home: string, sessionId: string) {
  const records: ReviewRecord[] = [];
  for (const directory of await directories(home, sessionId)) {
    const root = join(reviewDirectory(home, sessionId), directory);
    for (const name of (await readdir(root)).filter((name) =>
      /^report-[a-f0-9-]{36}\.json$/.test(name),
    )) {
      const record = reviewRecordSchema.parse(await readJson(join(root, name)));
      if (
        record.evidence.sessionId !== sessionId ||
        record.evidence.root !== root
      )
        throw new Error("历史报告归属不符");
      records.push(record);
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function sessionReviewStatus(home: string, sessionId: string) {
  const state = await readSessionState(home, sessionId);
  return {
    pending:
      state.phase === "interrupted" ||
      state.reviewedVersion !== state.evidenceVersion,
    evidenceVersion: state.evidenceVersion,
    reviewedVersion: state.reviewedVersion,
    reports: await listSessionReviews(home, sessionId),
  };
}
