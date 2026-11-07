import { z } from "zod";

// 校验空白而不裁剪原文，避免改变用户代码、换行或技能参数。
const requestTextSchema = z
  .string()
  .min(1)
  .max(65536)
  .refine((value) => value.trim().length > 0, "请求内容不能为空白");

// 技能名称只作原生标识，不允许路径遍历、空分段或shell语法。
export const nativeSkillNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);

export const executableSessionRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), prompt: requestTextSchema }).strict(),
  z
    .object({
      type: z.literal("skill"),
      name: nativeSkillNameSchema,
      args: z.string().max(65536).optional(),
    })
    .strict(),
]);
export type ExecutableSessionRequest = z.infer<
  typeof executableSessionRequestSchema
>;

// 只读能力查询与执行请求分离，调用方不能据此创建正式会话。
export const readonlySessionRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("capabilities") }).strict(),
  z.object({ type: z.literal("skills") }).strict(),
]);
export type ReadonlySessionRequest = z.infer<
  typeof readonlySessionRequestSchema
>;
