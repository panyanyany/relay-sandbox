import { join } from "node:path";
import { readJson } from "../storage/files.js";
import { taskPath } from "../tasks/store.js";
import { auditReport, type AuditReport } from "./report.js";
// 缺少采集结果和保留期已结束都明确报告不可用，其他读取错误直接抛出。
export async function loadAudit(
  home: string,
  id: string,
): Promise<AuditReport> {
  try {
    return await readJson<AuditReport>(join(taskPath(home, id), "audit.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return auditReport(
      [],
      ["审计报告尚未产生或已按保留策略清理，无法完整判断敏感操作"],
    );
  }
}

// 相同敏感操作聚合计数，向模型提供有界摘要；完整事件通过分页工具读取。
export function summarizeAudit(report: AuditReport) {
  const groups = new Map<
    string,
    AuditReport["events"][number] & { count: number }
  >();
  for (const event of report.events) {
    const key = JSON.stringify([event.target, event.action, event.result]);
    const previous = groups.get(key);
    if (previous) previous.count++;
    else groups.set(key, { ...event, count: 1 });
  }
  const events = [...groups.values()].sort(
    (a, b) =>
      Number(/\.ssh|\.aws|credentials|\/proc\/.*environ/.test(b.target)) -
      Number(/\.ssh|\.aws|credentials|\/proc\/.*environ/.test(a.target)),
  );
  return {
    coverage: report.coverage,
    gaps: report.gaps,
    eventCount: report.events.length,
    uniqueOperationCount: events.length,
    events: events.slice(0, 20),
    truncated: events.length > 20,
    detailTool: "get_audit",
  };
}
