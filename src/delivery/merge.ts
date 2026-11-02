import {
  mkdir,
  writeFile,
  unlink,
  symlink,
  chmod,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changes } from "../workspace/diff.js";
import { scan, readStable, type Manifest } from "../workspace/manifest.js";
import { candidatePath } from "../workspace/paths.js";
const exec = promisify(execFile);
export interface MergeResult {
  conflicts: string[];
  manifest: Manifest;
}
// 合并只生成候选目录，不触碰原项目；二进制和类型冲突明确交给宿主处理。
export async function mergeCandidate(
  baselineRoot: string,
  resultRoot: string,
  currentRoot: string,
  candidate: string,
): Promise<MergeResult> {
  const baseline = await scan(baselineRoot),
    result = await scan(resultRoot),
    current = await scan(currentRoot);
  const currentMap = new Map(current.map((e) => [e.path, e]));
  const conflicts: string[] = [];
  await mkdir(candidate, { recursive: true });
  for (const change of changes(baseline, result)) {
    if (change.path === ".git" || change.path.startsWith(".git/")) continue;
    const existing = currentMap.get(change.path);
    if (
      existing?.hash === change.after?.hash &&
      existing?.mode === change.after?.mode &&
      existing?.type === change.after?.type
    )
      continue;
    const clean =
      (!existing && !change.before) ||
      (existing &&
        change.before &&
        existing.hash === change.before.hash &&
        existing.mode === change.before.mode &&
        existing.type === change.before.type);
    if (clean) {
      const path = await candidatePath(candidate, change.path);
      if (
        existing?.type === "directory" &&
        change.after?.type === "directory"
      ) {
        await chmod(path, change.after.mode);
        continue;
      }
      if (existing?.type === "directory") {
        try {
          await rmdir(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            conflicts.push(change.path);
            continue;
          }
          throw error;
        }
      } else if (existing) await unlink(path);
      if (change.after?.type === "directory") {
        await mkdir(path);
        await chmod(path, change.after.mode);
        continue;
      }
      if (change.after?.type === "file") {
        await writeFile(path, await readStable(resultRoot, change.path), {
          mode: change.after.mode,
          flag: "wx",
        });
        await chmod(path, change.after.mode);
      } else if (change.after?.type === "symlink")
        await symlink(change.after.link!, path);
      continue;
    }
    if (
      !existing ||
      !change.before ||
      !change.after ||
      [existing, change.before, change.after].some((e) => e.type !== "file")
    ) {
      conflicts.push(change.path);
      continue;
    }
    const contents = await Promise.all(
      [currentRoot, baselineRoot, resultRoot].map((root) =>
        readStable(root, change.path),
      ),
    );
    if (contents.some((data) => data.includes(0))) {
      conflicts.push(change.path);
      continue;
    }
    try {
      const merged = await exec(
        "git",
        [
          "merge-file",
          "-p",
          join(currentRoot, change.path),
          join(baselineRoot, change.path),
          join(resultRoot, change.path),
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const target = await candidatePath(candidate, change.path);
      await unlink(target);
      await writeFile(target, merged.stdout, {
        mode: change.after.mode,
        flag: "wx",
      });
      await chmod(target, change.after.mode);
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === "number")
        conflicts.push(change.path);
      else throw error;
    }
  }
  return { conflicts, manifest: current };
}
