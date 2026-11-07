import type { Command } from "commander";
import { z } from "zod";
import { requestSessionWorker } from "../sessions/worker-api.js";
import { readSessionState } from "../sessions/state.js";
import { sessionReviewStatus } from "../sessions/review/state.js";
import { replaySessionEvents } from "../sessions/event-store.js";
import { readJson } from "../storage/files.js";
import { sessionPath } from "../terminal/session.js";
import { developmentSessionSchema } from "../sessions/schema.js";

// 只返回可公开状态，不返回操作令牌、环境变量或凭据。
export async function developmentSessionStatus(home: string, id: string) {
  z.uuid().parse(id);
  const session = developmentSessionSchema.parse(
    await readJson(sessionPath(home, id)),
  );
  if (session.id !== id) throw new Error("会话身份不匹配");
  let worker: Record<string, unknown>;
  try {
    worker = await requestSessionWorker(home, id, { type: "status" });
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    worker = { online: false, warning: "后台不在线；保留现场，未自动重放任务" };
  }
  return {
    ...worker,
    session,
    state: await readSessionState(home, id),
    review: await sessionReviewStatus(home, id),
  };
}
export function registerSessionCommands(program: Command, home: () => string) {
  program
    .command("session-worker <id>", { hidden: true })
    .action(async (id: string) => {
      // 只为开发会话加载厂商驱动，不增加旧任务命令的冷启动成本。
      const { startDevelopmentSessionWorker } =
        await import("../sessions/runtime.js");
      const worker = await startDevelopmentSessionWorker(home(), id);
      await worker.completion;
    });
  program
    .command("session-status <id>")
    .option("--json", "输出结构化状态")
    .action(async (id: string) =>
      console.log(JSON.stringify(await developmentSessionStatus(home(), id))),
    );
  program
    .command("session-events <id>")
    .option("--after <cursor>", "读取游标后的真实事件", "0")
    .action(async (id: string, options: { after: string }) => {
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(options.after);
      console.log(
        JSON.stringify(
          await replaySessionEvents(home(), z.uuid().parse(id), after),
        ),
      );
    });
  program
    .command("session-resume <id>")
    .description("显式恢复并等待 Agent 原生上下文就绪，不重放提示词")
    .action(async (id: string) => {
      z.uuid().parse(id);
      const [{ recoverSession }, { dockerClient }] = await Promise.all([
        import("../sessions/recovery.js"),
        import("../docker/client.js"),
      ]);
      const session = developmentSessionSchema.parse(
        await readJson(sessionPath(home(), id)),
      );
      if (session.id !== id) throw new Error("会话身份不匹配");
      console.log(
        JSON.stringify(
          await recoverSession({
            home: home(),
            session,
            docker: dockerClient(),
          }),
        ),
      );
    });
  program
    .command("session-stop <id>")
    .option("--json", "输出结构化停止结果")
    .action(async (id: string) =>
      console.log(
        JSON.stringify(
          await requestSessionWorker(home(), id, { type: "stop" }),
        ),
      ),
    );
}
