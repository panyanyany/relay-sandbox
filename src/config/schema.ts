import { z } from "zod";

export const agentType = z.enum(["codex", "claude-code", "opencode"]);
export type AgentType = z.infer<typeof agentType>;
const command = z
  .object({ name: z.string().min(1), argv: z.array(z.string()).min(1) })
  .strict();
// 配置只暴露产品选项，不暴露宿主挂载或容器权限。
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z
      .object({ exclude: z.array(z.string()).default([]) })
      .strict()
      .default({ exclude: [] }),
    // 项目只声明资源名称，实际权限只能来自可信宿主配置。
    resourceRequests: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/))
      .refine(
        (names) => new Set(names).size === names.length,
        "资源申请名称不可重复",
      )
      .default([]),
    hostAgent: z
      .object({ type: agentType.default("codex") })
      .strict()
      .default({ type: "codex" }),
    developmentAgent: z
      .object({
        type: agentType.default("codex"),
        profile: z
          .string()
          .regex(/^[\w-]+$/)
          .default("relay-default"),
      })
      .strict()
      .default({ type: "codex", profile: "relay-default" }),
    delivery: z
      .object({
        aiReview: z.boolean().default(true),
        checks: z
          .array(command)
          .refine(
            (checks) =>
              new Set(checks.map((check) => check.name)).size === checks.length,
            "检查名称不可重复",
          )
          .default([]),
        maxRepairRounds: z.number().int().min(0).max(10).default(2),
      })
      .strict()
      .default({ aiReview: true, checks: [], maxRepairRounds: 2 }),
    lifecycle: z
      .object({
        taskTimeoutMinutes: z.number().positive().default(120),
        finishedRetentionHours: z.number().positive().default(24),
        leaseSeconds: z.number().int().min(3).default(30),
        interruptedRetentionHours: z.number().positive().default(24),
      })
      .strict()
      .default({
        finishedRetentionHours: 24,
        taskTimeoutMinutes: 120,
        leaseSeconds: 30,
        interruptedRetentionHours: 24,
      }),
    resources: z
      .object({
        cpus: z.number().positive().default(2),
        memoryMiB: z.number().int().min(64).default(4096),
        pids: z.number().int().min(16).default(256),
        maxOutputBytes: z.number().int().positive().default(1048576),
      })
      .strict()
      .default({
        cpus: 2,
        memoryMiB: 4096,
        pids: 256,
        maxOutputBytes: 1048576,
      }),
    logging: z
      .object({
        sampleIntervalSeconds: z.number().int().min(1).max(60).default(10),
        maxFileBytes: z.number().int().min(4096).default(1048576),
        maxFiles: z.number().int().min(1).max(100).default(5),
        retentionDays: z.number().positive().default(7),
      })
      .strict()
      .default({
        sampleIntervalSeconds: 10,
        maxFileBytes: 1048576,
        maxFiles: 5,
        retentionDays: 7,
      }),
    network: z
      .object({ hostAddresses: z.array(z.ipv4()).default([]) })
      .strict()
      .default({ hostAddresses: [] }),
    audit: z
      .object({ reportRetentionDays: z.number().positive().default(7) })
      .strict()
      .default({ reportRetentionDays: 7 }),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const profileSchema = z
  .object({
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }, "中转站仅支持不含内嵌凭据的 HTTP(S) 地址"),
    model: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    protocol: z.enum(["responses", "anthropic", "openai-compatible"]),
    image: z
      .string()
      .regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/),
    networkImage: z
      .string()
      .regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
