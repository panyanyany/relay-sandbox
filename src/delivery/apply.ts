import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Entry, Manifest } from "../workspace/manifest.js";
import { changes, type ChangeSet } from "../workspace/diff.js";
import { withFinalizer } from "../storage/finalize.js";
export interface ApplyPlan {
  taskId: string;
  artifactDigest: string;
  configDigest: string;
  changes: ChangeSet;
}
// Python 标准库 dir_fd + O_NOFOLLOW 把写入约束在打开的目录中，不按字符串拼宿主目标。
export async function applyChanges(
  root: string,
  source: string,
  backup: string,
  plan: ApplyPlan,
): Promise<void> {
  const script = fileURLToPath(
    new URL("../../scripts/safe-apply.py", import.meta.url),
  );
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", [script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (data: Buffer) => {
      error += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`应用失败，已停止；备份见 ${backup}\n${error}`)),
    );
    child.stdin.end(JSON.stringify({ root, source, backup, plan }));
  });
}
// 依据最终候选清单构造计划，未变化路径完全不进入应用器。
export function makePlan(
  taskId: string,
  artifactDigest: string,
  configDigest: string,
  current: Manifest,
  result: Manifest,
): ApplyPlan {
  return {
    taskId,
    artifactDigest,
    configDigest,
    changes: changes(current, result).filter(
      (change) => change.path !== ".git" && !change.path.startsWith(".git/"),
    ),
  };
}
export async function withProjectLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = join(root, ".relay-sandbox-apply.lock");
  await writeFile(
    lock,
    JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  return withFinalizer(operation, () => unlink(lock));
}
export async function readPlan(path: string): Promise<ApplyPlan> {
  return JSON.parse(await readFile(path, "utf8")) as ApplyPlan;
}
export function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode && a?.type === b?.type;
}
