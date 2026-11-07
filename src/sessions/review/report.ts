import { fixedCheckFacts } from "./check-facts.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getTask } from "../../tasks/store.js";
import { writeJson } from "../../storage/files.js";
import { formatError } from "../../audit/redaction.js";
import { environmentConfigDigest } from "../../tasks/environment.js";
import { readFrozenPolicy } from "../../permissions/freeze.js";
import {
  withSessionOperation,
  type SessionOperationLease,
} from "../operation.js";
import { readSessionState, updateSessionState } from "../state.js";
import { appendSessionEvent } from "../event-store.js";
import type { DevelopmentSession } from "../schema.js";
import {
  withReviewEvidence,
  type ReviewEvidence,
  type ReviewEvidenceOptions,
} from "./evidence.js";
import { loadReviewConfiguration } from "./config.js";
import {
  executeReview,
  type ReviewExecutionOptions,
  type ReviewExecution,
} from "./executor.js";
import {
  readReviewEvidence,
  reviewRecordSchema,
  type ReviewRecord,
} from "./state.js";

interface CommonOptions extends ReviewExecutionOptions {
  home: string;
  session: DevelopmentSession;
  execute?: typeof executeReview;
  loadConfiguration?: typeof loadReviewConfiguration;
}
export interface ReviewSessionOptions
  extends CommonOptions, ReviewEvidenceOptions {}
// UI与命令行共用摘要，避免只落盘而用户看不到审查结果。
export function reviewSummary(record: ReviewRecord) {
  if (record.execution.status === "incomplete")
    return `审查未完成：${record.execution.diagnostic}`;
  const result = record.execution.result;
  const axis = (value: typeof result.code) =>
    value.status === "skipped"
      ? "未执行"
      : `${value.decision.verdict}：${value.decision.summary}`;
  const checks = record.execution.checks
    .map((value) => {
      const item = value as { name?: string; status?: string };
      return `${item.name ?? "检查"}=${item.status ?? "未知"}`;
    })
    .join("、");
  return `代码审查：${axis(result.code)}；运行行为：${axis(result.behavior)}；配置检查：${checks || "未配置"}；证据版本 ${record.evidence.evidenceVersion}`;
}
async function perform(
  options: CommonOptions,
  evidence: ReviewEvidence,
  lease: SessionOperationLease,
) {
  const { home, session } = options;
  const id = randomUUID();
  await appendSessionEvent(home, session.id, {
    type: "review",
    payload: {
      reviewId: id,
      state: "started",
      evidenceVersion: evidence.evidenceVersion,
    },
  });
  let execution: ReviewExecution;
  try {
    const task = await getTask(home, evidence.taskId);
    // 只读任务已有授权快照，补审不得读取新授权或补建冻结记录。
    const policy = await readFrozenPolicy(home, task.id);
    if (!policy) throw new Error("审查缺少冻结授权快照");
    if (
      task.terminalSessionId !== session.id ||
      task.projectId !== session.projectId ||
      task.projectRoot !== session.cwd ||
      task.configDigest !== evidence.configDigest ||
      environmentConfigDigest(task.config, policy) !== evidence.configDigest
    )
      throw new Error("审查任务或冻结配置绑定不符");
    const context = await (
      options.loadConfiguration ?? loadReviewConfiguration
    )(home, task.config);
    execution = await (options.execute ?? executeReview)(evidence, context, {
      ...options,
      runChecks: (fixed, checks) =>
        fixedCheckFacts(
          fixed,
          checks,
          options.runChecks
            ? () => options.runChecks!(fixed, checks)
            : undefined,
        ),
    });
  } catch (error) {
    execution = { status: "incomplete", diagnostic: formatError(error) };
  }
  const record = reviewRecordSchema.parse({
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    evidence,
    execution,
  });
  await writeJson(join(evidence.root, `report-${id}.json`), record);
  const summary = reviewSummary(record);
  // 错误示范：旧版本补审不能把新开发版本的 reviewedVersion 向前推进。
  const state = await readSessionState(home, session.id);
  if (
    execution.status === "completed" &&
    state.evidenceVersion === evidence.evidenceVersion
  )
    await updateSessionState(home, session.id, lease, {
      reviewedVersion: evidence.evidenceVersion,
    });
  await appendSessionEvent(home, session.id, {
    type: "review",
    payload: {
      reviewId: id,
      state: execution.status === "incomplete" ? "incomplete" : "completed",
      evidenceVersion: evidence.evidenceVersion,
      detail: summary.slice(0, 65536),
    },
  });
  return { record, summary };
}
// 唯一采集所有者在worker内调用；冻结覆盖取证、模型审查、结果落盘和通知。
export async function reviewSession(options: ReviewSessionOptions) {
  return withReviewEvidence(
    options.home,
    options.session,
    options,
    (evidence, lease) => perform(options, evidence, lease),
  );
}
// 离线补审不启动开发或重取现场；仍以同一互斥租约排除正在运行的开发轮次。
export async function retrySessionReview(
  options: CommonOptions & { evidenceId: string },
) {
  return withSessionOperation(
    options.home,
    options.session.id,
    "review",
    async (lease) => {
      const evidence = await readReviewEvidence(
        options.home,
        options.session.id,
        options.evidenceId,
      );
      if (evidence.taskId !== options.session.taskId)
        throw new Error("固定证据不属于当前会话任务");
      return perform(options, evidence, lease);
    },
  );
}
