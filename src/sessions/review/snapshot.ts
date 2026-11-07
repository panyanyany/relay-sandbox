import { mkdir, readdir, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import type { Task } from "../../tasks/types.js";
import { snapshot } from "../../workspace/snapshot.js";
import { scan, manifestDigest } from "../../workspace/manifest.js";
import {
  MAX_EXPORT_FILE_BYTES,
  hashStable,
} from "../../workspace/stable-file.js";
import { download } from "../../docker/archive.js";
import { ExportBudget } from "../../docker/export-budget.js";
import { validateDirectRuntime } from "../../workspace/access.js";
import { redact } from "../../audit/redaction.js";
import { digest } from "../../storage/hash.js";
import { taskPath } from "../../tasks/store.js";

// 不跟随日志链接、不读取 profile/credential；日志缺口显式进入证据。
export async function copyReviewLogs(
  home: string,
  task: Task,
  root: string,
  secrets: string[],
  gaps: string[],
) {
  const budget = new ExportBudget({
    maxExportBytes: 8 * 1024 * 1024,
    maxExportEntries: 256,
  });
  const entries: { path: string; hash: string }[] = [];
  async function visit(source: string, relative: string) {
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        gaps.push(`日志尚未生成: ${relative}`);
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      gaps.push(`跳过非普通日志: ${relative}`);
      return;
    }
    budget.entry();
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort())
        await visit(join(source, name), join(relative, name));
      return;
    }
    const chunks: Buffer[] = [];
    await hashStable(
      taskPath(home, task.id),
      relative,
      async (chunk) => {
        budget.reserve(chunk.length);
        chunks.push(Buffer.from(chunk));
      },
      8 * 1024 * 1024,
    );
    const text = redact(Buffer.concat(chunks).toString("utf8"), secrets),
      target = join(root, relative);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600, flag: "wx" });
    entries.push({ path: relative, hash: digest(text) });
  }
  for (const name of ["audit.jsonl", "session-evidence.json", "telemetry"])
    await visit(join(taskPath(home, task.id), name), name);
  return digest(JSON.stringify(entries));
}
// 代码保持原字节供审查；开发档案及宿主审查密钥根本不进入代码来源。
export async function snapshotReviewCode(
  home: string,
  task: Task,
  docker: Docker,
  target: string,
) {
  const direct = await validateDirectRuntime(home, task, docker);
  const limits = task.config.resources;
  let manifest;
  if (direct) {
    const before = await scan(
      task.projectRoot,
      task.config.project.exclude,
      MAX_EXPORT_FILE_BYTES,
    );
    const budget = new ExportBudget(limits);
    for (const item of before) {
      budget.entry();
      if (item.type === "file") budget.reserve(item.size);
    }
    manifest = await snapshot(
      task.projectRoot,
      target,
      task.config.project.exclude,
      MAX_EXPORT_FILE_BYTES,
    );
  } else {
    await download(docker, task.containerId!, target, limits);
    manifest = await scan(target, [], MAX_EXPORT_FILE_BYTES);
  }
  return { manifest, codeDigest: manifestDigest(manifest), direct };
}
