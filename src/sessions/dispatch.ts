import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { formatError } from "../audit/redaction.js";
import { writeJson } from "../storage/files.js";
import { requestSessionWorker, sessionWorkerPaths } from "./worker-api.js";
// CLI 内部入口由装配层提供；参数仅包含目录和会话编号，不携带模型凭据。
export async function dispatchSessionWorker(
  home: string,
  id: string,
  options: { timeoutMs?: number; entry?: string } = {},
) {
  const paths = sessionWorkerPaths(home, id);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const source = import.meta.url.endsWith(".ts");
  const entry =
    options.entry ??
    fileURLToPath(
      new URL(source ? "../cli/main.ts" : "../cli/main.js", import.meta.url),
    );
  const child = spawn(
    process.execPath,
    [
      ...(source && !options.entry ? ["--import", "tsx"] : []),
      entry,
      "--home",
      home,
      "session-worker",
      id,
    ],
    { detached: true, stdio: "ignore", env: process.env },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? 180000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`会话后台启动退出：${child.exitCode}`);
      try {
        const status = await requestSessionWorker(
          home,
          id,
          { type: "status" },
          { timeoutMs: Math.min(500, Math.max(1, deadline - Date.now())) },
        );
        if (status.workerPid !== child.pid)
          throw new Error("会话已有其他后台进程，拒绝重复启动");
        return status;
      } catch (error) {
        if (
          !["ENOENT", "ECONNREFUSED"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
      await delay(50);
    }
    throw new Error("会话后台启动超时；未自动重放任何输入");
  } catch (error) {
    // 只终止本次派发的进程，不触碰已存在的会话后台。
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await writeJson(paths.diagnostic, {
      at: new Date().toISOString(),
      error: formatError(error),
    });
    throw error;
  }
}
