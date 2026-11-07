import { z } from "zod";
import { nativeSkillNameSchema } from "./requests.js";

// 发现和调用分别声明支持情况；未验证或不可用不能默认为支持。
export const capabilitySupportSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("supported") }).strict(),
  z
    .object({
      status: z.literal("unsupported"),
      reason: z
        .string()
        .min(1)
        .max(2048)
        .refine((value) => value.trim().length > 0),
    })
    .strict(),
]);
export type CapabilitySupport = z.infer<typeof capabilitySupportSchema>;

export const sessionCapabilitiesSchema = z
  .object({
    skills: z
      .object({
        list: capabilitySupportSchema,
        invoke: capabilitySupportSchema,
      })
      .strict(),
  })
  .strict();
export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;

// 列表仅投影Agent原生技能；不携带可执行shell或另建技能安装来源。
export const nativeSkillSchema = z
  .object({
    name: nativeSkillNameSchema,
    description: z.string().max(8192).optional(),
  })
  .strict();
export type NativeSkill = z.infer<typeof nativeSkillSchema>;
export const nativeSkillListSchema = z.array(nativeSkillSchema).max(10000);
