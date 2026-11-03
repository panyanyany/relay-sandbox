import { join } from "node:path";
import { taskPath } from "./store.js";
import type { Task } from "./types.js";

// 初始快照留作证据；交付使用已合入宿主增量、未吞掉 Agent 成果的有效基线。
export function deliveryBaseline(home: string, task: Task) {
  const root = taskPath(home, task.id);
  return task.workspaceSync?.deliveryBase
    ? join(
        root,
        "resume-sync",
        task.workspaceSync.deliveryBase,
        "delivery-baseline",
      )
    : join(root, "baseline");
}
