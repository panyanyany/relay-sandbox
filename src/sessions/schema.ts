import { z } from "zod";

// 开发身份与旧宿主线程分开建模，原生标识只属于选定的开发 Agent。
export const developmentIdentitySchema = z
  .object({
    cwd: z.string().min(1),
    projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    agent: z.enum(["codex", "claude-code", "opencode"]),
  })
  .strict();
export const developmentSessionSchema = developmentIdentitySchema
  .extend({
    version: z.literal(2),
    kind: z.literal("development"),
    id: z.uuid(),
    nativeSessionId: z.string().min(1).optional(),
    taskId: z.uuid().optional(),
    environmentId: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DevelopmentIdentity = z.infer<typeof developmentIdentitySchema>;
export type DevelopmentSession = z.infer<typeof developmentSessionSchema>;
export type CreateDevelopmentSession = DevelopmentIdentity & {
  taskId?: string;
  environmentId?: string;
};
