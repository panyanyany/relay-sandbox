import {
  nativeSkillListSchema,
  type NativeSkill,
  type SessionCapabilities,
} from "../../sessions/capabilities.js";
import type { ExecutableSessionRequest } from "../../sessions/requests.js";

const invocationReason =
  "当前 Claude 结构化协议尚未验证独立原生技能调用接口；不能将技能拼接为普通提示词执行";

// 仅投影真实 system/init 缓存；读取能力不会启动进程或发送探测提示。
export function createClaudeSkills(input: {
  getInitialization(): Readonly<Record<string, unknown>> | undefined;
}) {
  function discoveryReason(): string | undefined {
    const initialization = input.getInitialization();
    if (!initialization) return "尚未收到 Claude system/init，原生技能列表暂不可用";
    if (initialization.skills === undefined)
      return "Claude system/init 没有提供 skills 字段，无法发现原生技能";
    return undefined;
  }
  return {
    capabilities(): SessionCapabilities {
      const reason = discoveryReason();
      return {
        skills: {
          list: reason
            ? { status: "unsupported", reason }
            : { status: "supported" },
          invoke: { status: "unsupported", reason: invocationReason },
        },
      };
    },
    list(): NativeSkill[] {
      const reason = discoveryReason();
      if (reason) throw new Error(reason);
      const initialization = input.getInitialization()!;
      // 错误示范：slash_commands 包含 compact 等普通命令，不能冒充技能。
      const names = initialization.skills;
      if (!Array.isArray(names)) throw new Error("Claude skills 必须是数组");
      return nativeSkillListSchema.parse(names.map((name) => ({ name })));
    },
    async invoke(_request: Extract<ExecutableSessionRequest, { type: "skill" }>): Promise<never> {
      throw new Error(invocationReason);
    },
  };
}
