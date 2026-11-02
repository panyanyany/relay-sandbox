import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scan } from "../workspace/manifest.js";
import { readPlan, sameEntry } from "./apply.js";
import { getTask, taskPath } from "../tasks/store.js";
// 只诊断部分应用，不自动回放或回滚，以免覆盖崩溃后用户的再次修改。
export async function inspectApplication(home: string, id: string) {
  const task = await getTask(home, id),
    root = taskPath(home, id),
    plan = await readPlan(join(root, "apply-plan.json"));
  const current = new Map(
    (await scan(task.projectRoot, task.config.project.exclude)).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const journal = (await readFile(join(root, "backup/applied.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return {
    taskId: id,
    journal,
    backup: join(root, "backup/files"),
    paths: plan.changes.map((change) => ({
      path: change.path,
      state: sameEntry(current.get(change.path), change.after)
        ? "applied"
        : sameEntry(current.get(change.path), change.before)
          ? "original"
          : "diverged",
    })),
  };
}
