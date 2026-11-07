import { resolve } from "node:path";
import { startAudit, type AuditSession } from "../audit/collector.js";
import { dockerClient } from "../docker/client.js";
import { startMonitor } from "../monitoring/monitor.js";
import { getTask } from "../tasks/store.js";
import { writeJson } from "../storage/files.js";
import { redact } from "../audit/redaction.js";
import type { AuditReport } from "../audit/report.js";
import type { Task } from "../tasks/types.js";
import type { DevelopmentSession } from "./schema.js";
import {
  sessionEvidencePaths,
  writeSessionEvidenceIndex,
} from "./evidence-index.js";

interface Dependencies {
  collect: typeof startAudit;
  monitor: typeof startMonitor;
}
export interface SessionAudit {
  snapshot(): Promise<AuditReport>;
  index(): ReturnType<typeof writeSessionEvidenceIndex>;
  finish(): Promise<AuditReport>;
}
// 此映射属于唯一 worker 的生命周期；客户端只能观察，不拥有采集器。
const active = new Map<string, Promise<SessionAudit>>();
const collecting: AuditReport = {
  coverage: "unavailable",
  events: [],
  gaps: ["采集进行中，覆盖与事件尚未完成汇总，不能据此判断没有敏感行为"],
  warnings: ["尚未进行独立 AI 审查"],
};
function cleanReport(report: AuditReport, secrets: string[]): AuditReport {
  return {
    coverage: report.coverage,
    gaps: report.gaps.map((value) => redact(value, secrets)),
    warnings: report.warnings.map((value) => redact(value, secrets)),
    events: report.events.map((event) => ({
      ...event,
      target: redact(event.target, secrets),
      action: redact(event.action, secrets),
      source: redact(event.source, secrets),
    })),
  };
}
// 必须由取得独占后台所有权的 worker 调用；附加、断开不触发 finish。
export async function startSessionAudit(
  home: string,
  session: DevelopmentSession,
  task: Task,
  devSecrets: string[] = [],
  dependencies: Partial<Dependencies> = {},
): Promise<SessionAudit> {
  const trusted = await getTask(home, task.id);
  if (
    session.taskId !== trusted.id ||
    trusted.terminalSessionId !== session.id ||
    trusted.projectId !== session.projectId ||
    trusted.projectRoot !== session.cwd ||
    trusted.containerId !== task.containerId
  )
    throw new Error("审计任务与会话归属不一致");
  if (!trusted.containerId || !trusted.environmentReady)
    throw new Error("审计运行环境未就绪");
  const key = `${resolve(home)}:${session.id}`;
  const existing = active.get(key);
  if (existing) return existing;
  const pending = (async () => {
    // 复用既有锁、轮转和预算；不创建另一套采样定时器。
    await (dependencies.monitor ?? startMonitor)(home, trusted.id);
    const paths = sessionEvidencePaths(home, trusted.id);
    await writeSessionEvidenceIndex(
      home,
      session,
      trusted.id,
      "collecting",
      collecting,
    );
    const collector: AuditSession = await (dependencies.collect ?? startAudit)(
      dockerClient(),
      trusted.containerId!,
      trusted.id,
      paths.events,
      devSecrets,
    );
    let result: AuditReport | undefined;
    let finished: Promise<AuditReport> | undefined;
    return {
      async snapshot() {
        return result
          ? structuredClone(result)
          : collector.snapshot
            ? cleanReport(await collector.snapshot(), devSecrets)
            : structuredClone(collecting);
      },
      async index() {
        const report =
          result ??
          (collector.snapshot
            ? cleanReport(await collector.snapshot(), devSecrets)
            : collecting);
        return writeSessionEvidenceIndex(
          home,
          session,
          trusted.id,
          result ? "finished" : "collecting",
          report,
        );
      },
      finish() {
        // 错误示范：前端断连就 finish 会导致后台仍在开发但审计已停止。
        finished ??= (async () => {
          const report = cleanReport(await collector.finish(), devSecrets);
          await writeJson(paths.report, report);
          await writeSessionEvidenceIndex(
            home,
            session,
            trusted.id,
            "finished",
            report,
          );
          result = report;
          return structuredClone(report);
        })();
        return finished;
      },
    };
  })();
  active.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    active.delete(key);
    throw error;
  }
}
