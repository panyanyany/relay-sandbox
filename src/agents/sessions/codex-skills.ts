import { z } from "zod";
import type { SessionOperationLease } from "../../sessions/operation.js";
import {
  nativeSkillListSchema,
  type SessionCapabilities,
} from "../../sessions/capabilities.js";
import {
  executableSessionRequestSchema,
  type ExecutableSessionRequest,
} from "../../sessions/requests.js";
import type { CodexTurnInput } from "./codex-gateway.js";

interface CodexSkillBackend {
  read(method: string, params: Record<string, unknown>): Promise<unknown>;
  submitInputs(
    inputs: CodexTurnInput[],
    context: { lease: SessionOperationLease },
  ): Promise<void>;
  submit(
    prompt: string,
    context: { lease: SessionOperationLease },
  ): Promise<void>;
}
const skillResponseSchema = z.object({
  data: z.array(
    z.object({
      skills: z.array(
        z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          description: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

// 技能名称由用户选择，文件路径始终从当前Agent的真实只读列表解析。
export function createCodexSkills(backend: CodexSkillBackend) {
  const capabilities: SessionCapabilities = {
    skills: { list: { status: "supported" }, invoke: { status: "supported" } },
  };
  async function nativeSkills() {
    const response = skillResponseSchema.parse(
      await backend.read("skills/list", { cwds: ["/workspace"] }),
    );
    return response.data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled !== false);
  }
  return {
    async capabilities() {
      return capabilities;
    },
    async listSkills() {
      const skills = await nativeSkills();
      return nativeSkillListSchema.parse(
        skills.map(({ name, description }) => ({
          name,
          ...(description === undefined ? {} : { description }),
        })),
      );
    },
    // 调用方已经保存请求并持有租约；本适配器不创建会话、不重复获取执行锁。
    async execute(
      request: ExecutableSessionRequest,
      context: { lease: SessionOperationLease },
    ) {
      const valid = executableSessionRequestSchema.parse(request);
      if (valid.type === "message")
        return backend.submit(valid.prompt, context);
      const matches = (await nativeSkills()).filter(
        (skill) => skill.name === valid.name,
      );
      const paths = new Set(matches.map((skill) => skill.path));
      if (paths.size === 0)
        throw new Error(`未找到Codex原生技能: ${valid.name}`);
      if (paths.size !== 1)
        throw new Error(`Codex原生技能存在路径歧义: ${valid.name}`);
      const skill = matches[0]!;
      const inputs: CodexTurnInput[] = [
        { type: "skill", name: skill.name, path: skill.path },
      ];
      // 错误示范：把技能内容拼到prompt会失去原生技能语义；参数使用独立text项。
      if (valid.args !== undefined && valid.args.length > 0)
        inputs.push({ type: "text", text: valid.args });
      await backend.submitInputs(inputs, context);
    },
  };
}
