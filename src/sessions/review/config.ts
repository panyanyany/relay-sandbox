import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { agentType, type Config } from "../../config/schema.js";
import { loadProfile } from "../../config/load.js";
import { readCredential } from "../../config/credentials.js";

// 只有可信宿主目录声明审查档案，项目代码不能指定审查凭据。
export const reviewConfigurationSchema = z
  .object({
    agent: agentType.default("codex"),
    profile: z.string().regex(/^[\w-]+$/),
    runtimeReview: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(600000).default(120000),
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024)
      .default(1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .default(256 * 1024),
  })
  .strict();
export type ReviewConfiguration = z.infer<typeof reviewConfigurationSchema>;

// 错误示范：缺少 review.yaml 时借用 developmentAgent.profile 会混淆角色。
export async function loadReviewConfiguration(home: string, project: Config) {
  const configuration = reviewConfigurationSchema.parse(
    parse(await readFile(join(home, "review.yaml"), "utf8")),
  );
  const profile = await loadProfile(home, configuration.profile);
  const development = await loadProfile(home, project.developmentAgent.profile);
  if (
    configuration.profile === project.developmentAgent.profile ||
    profile.apiKeyEnv === development.apiKeyEnv
  )
    throw new Error("审查必须使用独立档案和独立凭据变量");
  if (!project.delivery.aiReview && !configuration.runtimeReview)
    return { configuration, profile, key: "", project };
  const credential = await readCredential(home, profile);
  if (!credential) throw new Error("独立审查凭据不可用；审查未完成");
  const devCredential = await readCredential(home, development);
  if (devCredential?.key === credential.key)
    throw new Error("审查与开发密钥必须分离");
  return { configuration, profile, key: credential.key, project };
}
export type ReviewContext = Awaited<ReturnType<typeof loadReviewConfiguration>>;
