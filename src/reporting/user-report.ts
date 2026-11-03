import { buildPolicySummary, policySummaryLines } from "./policy-summary.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { telemetryStatus } from "../monitoring/status.js";
import { loadAudit } from "../audit/load.js";
import { redact } from "../audit/redaction.js";
import { getTask, taskPath } from "../tasks/store.js";
import { withTaskLock } from "../tasks/lock.js";
import { writeJson, readJson } from "../storage/files.js";
import { reviewSchema } from "../agents/host/review-schema.js";

export const userEmissionSchema = z
  .object({ reportId: z.string().min(1), userMessage: z.string().min(1) })
  .strict();

// 上报事实由宿主记录生成，AI 不传入“已应用/无风险”等可被伪造的状态。
export async function buildUserReport(home: string, id: string) {
  const task = await getTask(home, id),
    audit = await loadAudit(home, id);
  const monitoring = await telemetryStatus(home, id);
  const policy = await buildPolicySummary(home, id);
  const direct =
    policy.projectMode === "direct" || task.projectMode === "direct";
  const parsed = reviewSchema.safeParse(task.review);
  const review =
    parsed.success &&
    parsed.data.artifactDigest === task.artifactDigest &&
    parsed.data.configDigest === task.configDigest &&
    parsed.data.taskId === id
      ? parsed.data
      : undefined;
  const applied =
    task.applicationStatus === "applied" || task.state === "completed";
  const unchanged = task.applicationStatus === "not_attempted";
  const blocked =
    !applied &&
    ((task.config.delivery.aiReview && review?.verdict !== "approve") ||
      task.checks.some((c) => c.status === "failed" || c.status === "error"));
  const deliveryStatus = applied
    ? "applied"
    : unchanged
      ? blocked
        ? "blocked"
        : "not_applied"
      : "unknown";
  const facts = {
    schemaVersion: 1,
    taskId: id,
    artifactDigest: task.artifactDigest ?? null,
    configDigest: task.configDigest,
    deliveryStatus,
    projectMode: policy.projectMode,
    deliveryKind: direct ? "post_write_check" : "apply",
    // 直接共享下无法区分开发Agent与宿主并发写入，不把确认检查冒充任务归因。
    originalProjectChangedByTask: direct
      ? null
      : applied
        ? true
        : unchanged
          ? false
          : null,
    reviewVerdict: task.config.delivery.aiReview
      ? (review?.verdict ?? "not_reviewed")
      : "disabled",
    findings: review?.findings ?? [],
    audit,
    policy,
    checksDisabled:
      !task.config.delivery.aiReview && !task.config.delivery.checks.length,
    checks: task.checks,
    warnings: task.warnings,
    cleanupStatus: task.state === "cleaned" ? "cleaned" : "pending",
    taskState: task.state,
    error: task.error ?? null,
    telemetry: {
      directory: "telemetry/",
      note: "宿主定时指标；无记录或采样间隔内的瞬时变化无法完整回溯",
    },
  };
  const deliveryText = {
    applied: direct
      ? facts.checksDisabled
        ? "原项目结果已确认（未执行交付检查）"
        : "原项目事后检查已通过"
      : "已应用",
    blocked: direct ? "原项目事后检查未通过" : "已阻止交付",
    not_applied: direct ? "尚未完成原项目事后检查" : "尚未应用",
    unknown: "应用结果需人工核查",
  }[deliveryStatus];
  const auditHighlights = audit.events
    .map((event, index) => ({
      event,
      id: index + 1,
      priority: /\.ssh|\.aws|credentials|\/proc\/.*environ/.test(event.target)
        ? 1
        : 0,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10);
  const lines = [
    `任务 ${id}。交付：${deliveryText}。`,
    direct
      ? "原项目：开发期间可能已被直接修改；检查或审核拒绝不会撤销已有修改。"
      : applied
        ? "原项目：本任务已应用修改。"
        : unchanged
          ? "原项目：未由本任务应用修改。"
          : "原项目：本任务的修改影响尚不能确认，请检查应用日志和备份。",
    `审核：${facts.reviewVerdict}。${review?.summary ?? ""}`,
    ...facts.findings
      .slice(0, 20)
      .map(
        (f) =>
          `风险 ${f.id} [${f.category}/${f.severity}] ${f.file}:${f.line}：${f.description}；证据：${f.evidence}`,
      ),
    ...(facts.findings.length > 20
      ? [`风险共 ${facts.findings.length} 项，完整记录见宿主任务审核。`]
      : []),
    `审计：${audit.coverage === "partial" ? "部分覆盖" : audit.coverage === "unavailable" ? "不可用" : "采集器报告可用"}；记录 ${audit.events.length} 项敏感操作。`,
    ...auditHighlights.map(
      ({ event: e, id }) =>
        `审计 A${id}：${e.target}，${e.action}，${e.result}。`,
    ),
    `指标日志：${monitoring.latest ? `最后记录 ${monitoring.latest.time}` : "尚无有效采样"}。`,
    ...(monitoring.latest && "kind" in monitoring.latest
      ? [`指标采样失败：${monitoring.latest.error}`]
      : []),
    ...(monitoring.latest && "containers" in monitoring.latest
      ? monitoring.latest.containers
          .filter((c) => "running" in c && (!c.running || c.oomKilled))
          .map(
            (c) =>
              `容器异常：${c.id} 状态=${c.state}，${"oomKilled" in c ? `OOM=${c.oomKilled}，退出码=${c.exitCode}` : "已移除"}`,
          )
      : []),
    ...audit.gaps.map((g) => `审计缺口：${g}`),
    ...policySummaryLines(policy),
    ...(facts.checksDisabled ? ["未执行交付检查。"] : []),
    ...task.warnings.map((w) => `提醒：${w}`),
    ...(task.error ? [`错误：${task.error}`] : []),
    `清理：${facts.cleanupStatus === "cleaned" ? "已清理运行资源" : "尚未完成"}；宿主保留报告和备份。`,
  ];
  const safe = JSON.parse(
    redact(JSON.stringify({ ...facts, userMessage: lines.join("\n") })),
  ) as typeof facts & { userMessage: string };
  // 错误示范：用含采样时间的整份报告校验新鲜度，会拒绝正常采样后的回执。
  // 关键事实包含风险变化；普通采样时间、CPU和内存波动不影响已准备快照。
  const telemetryHealth = !monitoring.latest
    ? []
    : "kind" in monitoring.latest
      ? { error: monitoring.latest.error }
      : monitoring.latest.containers
          .filter((c) => !("running" in c) || !c.running || c.oomKilled)
          .map((c) =>
            "running" in c
              ? {
                  id: c.id,
                  state: c.state,
                  running: c.running,
                  oomKilled: c.oomKilled,
                  exitCode: c.exitCode,
                }
              : { id: c.id, removed: true },
          )
          .sort((a, b) => a.id.localeCompare(b.id));
  const factsVersion = createHash("sha256")
    .update(
      redact(
        JSON.stringify({
          facts,
          reviewSummary: review?.summary,
          telemetryHealth,
        }),
      ),
    )
    .digest("hex");
  const reportId = createHash("sha256")
    .update(JSON.stringify(safe))
    .digest("hex");
  return { ...safe, reportId, factsVersion };
}

// 生成只表示待向用户输出，不能冒充已送达；重复相同事实生成同一个标识。
export async function prepareUserReport(home: string, id: string) {
  return withTaskLock(home, id, async () => {
    const report = await buildUserReport(home, id);
    await writeJson(join(taskPath(home, id), "user-report.json"), report);
    return {
      schemaVersion: report.schemaVersion,
      taskId: report.taskId,
      reportId: report.reportId,
      userMessage: report.userMessage,
      reviewVerdict: report.reviewVerdict,
      deliveryStatus: report.deliveryStatus,
      projectMode: report.projectMode,
      deliveryKind: report.deliveryKind,
      originalProjectChangedByTask: report.originalProjectChangedByTask,
      cleanupStatus: report.cleanupStatus,
      emissionStatus: "prepared",
      finalOutputSchema: z.toJSONSchema(userEmissionSchema),
      nextAction:
        "将 reportId、userMessage 原样作为最终用户回复；生成报告不等于已经向用户输出。",
    };
  });
}

// 由输出通道的接入方在看到最终回复后调用；MCP 不暴露伪造已送达的工具。
export async function recordUserEmission(
  home: string,
  id: string,
  output: unknown,
) {
  const emission = userEmissionSchema.parse(output);
  const prepared = await readJson<Awaited<ReturnType<typeof buildUserReport>>>(
    join(taskPath(home, id), "user-report.json"),
  );
  const current = await buildUserReport(home, id);
  if (
    emission.reportId !== prepared.reportId ||
    prepared.factsVersion !== current.factsVersion ||
    emission.userMessage !== prepared.userMessage
  )
    throw new Error("用户上报缺失、过期或内容与报告不符");
  const receipt = {
    taskId: id,
    reportId: emission.reportId,
    emittedAt: new Date().toISOString(),
    channel: "observed_final_output",
    status: "emitted",
  };
  await writeJson(
    join(taskPath(home, id), "user-report-emission.json"),
    receipt,
  );
  return receipt;
}
