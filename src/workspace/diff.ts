import type { Manifest, Entry } from "./manifest.js";
export interface Change {
  path: string;
  kind: "add" | "modify" | "delete";
  before?: Entry;
  after?: Entry;
}
export type ChangeSet = Change[];
// 差异只相对于任务初始副本，不把用户已有内容归为内层产出。
export function changes(baseline: Manifest, result: Manifest): ChangeSet {
  const old = new Map(baseline.map((e) => [e.path, e]));
  const next = new Map(result.map((e) => [e.path, e]));
  const output: ChangeSet = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const before = old.get(path),
      after = next.get(path);
    if (!before && after) output.push({ path, kind: "add", after });
    else if (before && !after) output.push({ path, kind: "delete", before });
    else if (
      before &&
      after &&
      (before.hash !== after.hash ||
        before.mode !== after.mode ||
        before.type !== after.type)
    )
      output.push({ path, kind: "modify", before, after });
  }
  // 先删后建；目录类型替换先于后代新增，删除按深度倒序避免递归删用户文件。
  const rank = (change: Change) =>
    change.kind === "delete"
      ? 0
      : change.before?.type === "directory" &&
          change.after?.type !== "directory"
        ? 1
        : change.after?.type === "directory"
          ? 2
          : 3;
  return output.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0
        ? b.path.split("/").length - a.path.split("/").length
        : a.path.split("/").length - b.path.split("/").length) ||
      a.path.localeCompare(b.path),
  );
}
