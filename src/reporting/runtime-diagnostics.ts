import type { RuntimeEventStatus } from "../monitoring/runtime-events.js";

// 只呈现证据；历史容器事件不能单凭137归因到当前开发轮次。
export function runtimeDiagnosticLines(status: RuntimeEventStatus | null) {
  if (!status) return ["Docker事件覆盖：尚无采集记录。"];
  const lines = [`Docker事件采集状态：${status.state}。`];
  if (status.lastGap)
    lines.push(
      `Docker事件覆盖缺口：${status.lastGap.updatedAt}，${status.lastGap.error}。`,
    );
  else if (status.state === "unavailable")
    lines.push(`Docker事件覆盖缺口：${status.error ?? "采集不可用"}。`);
  const events = [status.lastOom, status.lastIncident].filter(
    (event, index, values) =>
      event &&
      values.findIndex((v) => JSON.stringify(v) === JSON.stringify(event)) ===
        index,
  );
  for (const event of events) {
    if (!event) continue;
    lines.push(
      `Docker故障证据：容器=${event.containerId}，事件=${event.action}，时间=${event.time === null ? "未知" : new Date(event.time * 1000).toISOString()}，退出码=${event.exitCode ?? "未知"}；可能为历史记录，需结合本轮时间和停止来源核对，不能单独认定退出原因。`,
    );
  }
  return lines;
}
