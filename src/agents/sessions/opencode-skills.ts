import { z } from "zod";
import {
  nativeSkillListSchema,
  type NativeSkill,
  type SessionCapabilities,
} from "../../sessions/capabilities.js";
import {
  executableSessionRequestSchema,
  type ExecutableSessionRequest,
} from "../../sessions/requests.js";
import type { OpenCodeReply } from "./opencode-bridge.js";

const skillReplySchema = z
  .array(z.object({ name: z.string(), description: z.string().optional() }))
  .max(10000);

// 原生技能查询与执行能力分开声明；发现列表不能证明独立调用已经可用。
export function createOpenCodeSkills(input: {
  readCapability(path: "/skill" | "/command"): Promise<OpenCodeReply>;
  submit(prompt: string): Promise<void>;
}) {
  return {
    async capabilities(): Promise<SessionCapabilities> {
      return {
        skills: {
          list: { status: "supported" },
          invoke: {
            status: "unsupported",
            reason:
              "当前 OpenCode 适配器不支持独立原生技能调用；仅支持技能发现",
          },
        },
      };
    },
    async listSkills(): Promise<NativeSkill[]> {
      const reply = await input.readCapability("/skill");
      if (reply.status !== 200)
        throw new Error(`OpenCode 技能列表查询失败: HTTP ${reply.status}`);
      // 错误示范：把 /command 模板或技能全文拼进消息，冒充原生技能执行。
      const skills = skillReplySchema.parse(reply.body);
      return nativeSkillListSchema.parse(skills);
    },
    // 执行租约由调用层持有；不支持的技能必须在任何 message 请求前失败。
    async execute(request: ExecutableSessionRequest): Promise<void> {
      const parsed = executableSessionRequestSchema.parse(request);
      if (parsed.type === "skill")
        throw new Error("当前 OpenCode 适配器不支持独立原生技能调用");
      await input.submit(parsed.prompt);
    },
  };
}
