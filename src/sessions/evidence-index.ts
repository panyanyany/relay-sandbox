import { join } from "node:path";
import { taskPath } from "../tasks/store.js";
import { readSessionState } from "./state.js";
import { writeJson } from "../storage/files.js";
import type { AuditReport } from "../audit/report.js";
import type { DevelopmentSession } from "./schema.js";

// 文件路径只由宿主任务标识生成，不接受内层返回的路径。
export function sessionEvidencePaths(home: string, taskId: string) {
  const root = taskPath(home, taskId);
  return {
    events: join(root, "audit.jsonl"),
    report: join(root, "audit.json"),
    index: join(root, "session-evidence.json"),
    telemetry: join(root, "telemetry"),
  };
}
// 索引是定位与覆盖说明，不代表审查结论，也不会修改 reviewedVersion。
export async function writeSessionEvidenceIndex(
  home: string,
  session: DevelopmentSession,
  taskId: string,
  status: "collecting" | "finished",
  report: AuditReport,
) {
  const paths = sessionEvidencePaths(home, taskId);
  const { evidenceVersion } = await readSessionState(home, session.id);
  const index = {
    schemaVersion: 1,
    sessionId: session.id,
    taskId,
    evidenceVersion,
    status,
    updatedAt: new Date().toISOString(),
    coverage: report.coverage,
    gaps: report.gaps,
    paths,
  };
  await writeJson(paths.index, index);
  return index;
}
