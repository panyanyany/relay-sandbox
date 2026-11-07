import { z } from "zod";

const text = z.string().max(65_536);
// 屏幕字节与语义事件分离；错误示范：把 ANSI 屏幕伪装成 assistant 消息。
export const sessionEventInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      payload: z
        .object({
          role: z.enum(["user", "assistant"]),
          text,
          complete: z.boolean(),
          messageId: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      payload: z
        .object({
          name: z.string().min(1),
          callId: z.string().min(1),
          phase: z.enum(["started", "completed", "failed"]),
          text: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      payload: z
        .object({
          state: z.enum([
            "preparing",
            "idle",
            "busy",
            "reviewing",
            "stopped",
            "failed",
          ]),
          detail: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("review"),
      payload: z
        .object({
          reviewId: z.string().min(1),
          state: z.enum(["started", "completed", "incomplete"]),
          evidenceVersion: z.number().int().nonnegative(),
          detail: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("gap"),
      payload: z.object({ reason: text.min(1) }).strict(),
    })
    .strict(),
]);
const envelope = {
  version: z.literal(1),
  sessionId: z.uuid(),
  cursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.iso.datetime(),
};
// 每个分支都验证完整信封，避免依赖 intersection 对严格对象的特殊处理。
export const sessionEventSchema = z.discriminatedUnion("type", [
  sessionEventInputSchema.options[0].extend(envelope),
  sessionEventInputSchema.options[1].extend(envelope),
  sessionEventInputSchema.options[2].extend(envelope),
  sessionEventInputSchema.options[3].extend(envelope),
  sessionEventInputSchema.options[4].extend(envelope),
]);
export type SessionEventInput = z.infer<typeof sessionEventInputSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export interface SessionEventReplay {
  events: SessionEvent[];
  cursor: number;
  gap?: { from: number; to: number; reason: "retention" };
}
