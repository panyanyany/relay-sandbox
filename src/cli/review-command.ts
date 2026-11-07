import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readJson } from "../storage/files.js";
import { sessionPath } from "../terminal/session.js";
import { developmentSessionSchema } from "../sessions/schema.js";
import { reviewTask } from "../tasks/deliver.js";
import { requestSessionWorker } from "../sessions/worker-api.js";

// --file 明确选择旧任务交付审核，禁止依赖 ID 外观猜测对象类型。
export async function runSessionReview(
  home: string,
  id: string,
  options: { file?: string; evidence?: string; json?: boolean },
) {
  if (options.file) {
    if (options.evidence)
      throw new Error("任务审核文件与会话补审参数不能同时使用");
    return reviewTask(
      home,
      id,
      JSON.parse(await readFile(resolve(options.file), "utf8")),
    );
  }
  const session = developmentSessionSchema.parse(
    await readJson(sessionPath(home, id)),
  );
  if (session.id !== id) throw new Error("会话文件身份不匹配");
  try {
    return await requestSessionWorker(home, id, {
      type: "review",
      ...(options.evidence ? { evidenceId: options.evidence } : {}),
    });
  } catch (error) {
    // 只有旧固定证据能离线补审；不能为审查静默启动或重放开发。
    if (
      !options.evidence ||
      !["ENOENT", "ECONNREFUSED"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    // 只有离线补审才加载完整审查执行链。
    const { retrySessionReview } = await import("../sessions/review/report.js");
    return retrySessionReview({ home, session, evidenceId: options.evidence });
  }
}
export function registerReviewCommand(program: Command, home: () => string) {
  program
    .command("review <id>")
    .description("显式独立审查开发会话；--file 提交旧任务审核")
    .option("--file <path>", "任务结构化审核文件")
    .option("--evidence <id>", "对固定证据补审，不重新开发")
    .option("--json", "输出结构化报告")
    .action(
      async (
        id: string,
        options: { file?: string; evidence?: string; json?: boolean },
      ) => {
        const result = await runSessionReview(home(), id, options);
        if (options.json || options.file) console.log(JSON.stringify(result));
        else
          console.log(
            "summary" in result
              ? String(result.summary)
              : JSON.stringify(result),
          );
        const record =
          "record" in result
            ? (result.record as { execution?: { status?: string } })
            : undefined;
        if (record?.execution?.status === "incomplete") process.exitCode = 1;
      },
    );
}
