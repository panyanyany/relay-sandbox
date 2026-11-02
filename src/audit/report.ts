export interface AuditEvent {
  time: string;
  taskId: string;
  target: string;
  action: string;
  result: "success" | "blocked" | "unknown";
  source: string;
}
export interface AuditReport {
  coverage: "unavailable" | "partial" | "available";
  gaps: string[];
  events: AuditEvent[];
  warnings: string[];
}
// 明确暴露覆盖缺口；采集不可用不等于没有可疑操作。
export function auditReport(
  events: AuditEvent[] = [],
  gaps: string[] = [
    "尚未接入独立的内核审计采集器，无法确认是否有内部敏感资源访问或修改",
  ],
): AuditReport {
  return {
    coverage: gaps.length ? "unavailable" : "available",
    gaps,
    events,
    warnings: events.map(
      (e) =>
        `${e.target}: ${e.action}，${e.result === "unknown" ? "操作结果不明" : e.result}`,
    ),
  };
}
