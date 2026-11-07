import {
  executableSessionRequestSchema,
  type ExecutableSessionRequest,
} from "./requests.js";

export type SessionInput =
  | ExecutableSessionRequest
  | {
      type:
        | "help"
        | "status"
        | "exit"
        | "stop"
        | "review"
        | "skills"
        | "capabilities";
    };
export const SESSION_HELP =
  "/help /status /exit /stop /review /skills /skill <name> [args] /capabilities";

// 仅解释统一命令；exit由客户端关闭入口处理，不能转为后台stop。
export function parseSessionInput(input: string): SessionInput {
  const trimmed = input.trim();
  if (trimmed.startsWith("!")) throw new Error("统一输入不支持直接shell命令");
  if (!trimmed.startsWith("/"))
    return executableSessionRequestSchema.parse({
      type: "message",
      prompt: input,
    });
  const command = /^\/(help|status|exit|stop|review|skills|capabilities)$/.exec(
    trimmed,
  );
  if (command)
    return {
      type: command[1] as Exclude<SessionInput["type"], "message" | "skill">,
    };
  // 技能参数保留尾部空白及换行，仅去掉识别命令前的空白。
  const skill = /^\/skill\s+(\S+)(?:[ \t]+([^]*))?$/.exec(input.trimStart());
  if (skill)
    return executableSessionRequestSchema.parse({
      type: "skill",
      name: skill[1],
      ...(skill[2] === undefined ? {} : { args: skill[2] }),
    });
  throw new Error(`未知统一命令；可用命令：${SESSION_HELP}`);
}
