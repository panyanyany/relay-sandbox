import { z } from "zod";

// 固定分类供程序统计；证据仅描述代码和脱敏元数据。
export const findingSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum([
      "sensitive_access",
      "config_tampering",
      "data_exfiltration",
      "boundary_access",
      "backdoor",
      "check_bypass",
      "persistence",
      "resource_abuse",
      "correctness",
      "other",
    ]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    file: z.string().min(1),
    line: z.number().int().positive(),
    description: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
  })
  .strict();

// 不推断文字含义，只接受明确结论及绑定摘要；拒绝自相矛盾的批准。
export const reviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    artifactDigest: z.string().min(1),
    configDigest: z.string().min(1),
    verdict: z.enum(["approve", "reject", "needs_attention"]),
    summary: z.string().trim().min(1),
    findings: z.array(findingSchema).max(1000),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      new Set(review.findings.map((item) => item.id)).size !==
      review.findings.length
    )
      ctx.addIssue({
        code: "custom",
        message: "问题编号不可重复",
        path: ["findings"],
      });
    if (
      review.verdict === "approve" &&
      review.findings.some((item) =>
        ["high", "critical"].includes(item.severity),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "高风险问题未解决，不能批准",
        path: ["verdict"],
      });
  });
export type ReviewDecision = z.infer<typeof reviewSchema>;
