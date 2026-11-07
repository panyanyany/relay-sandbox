import { z } from "zod";
import { executableSessionRequestSchema } from "./requests.js";
import { sessionEventSchema, type SessionEvent } from "./events.js";
// 输入只有外部会话编号；原生 Agent ID 始终由宿主管理。
const identity = {
  sessionId: z.uuid().optional(),
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
export const jsonSessionInputSchema = z.union([
  z.object({ ...identity, prompt: z.string().min(1).max(65536) }).strict(),
  z.object({ ...identity, request: executableSessionRequestSchema }).strict(),
  z
    .object({
      ...identity,
      command: z.enum([
        "help",
        "status",
        "skills",
        "capabilities",
        "exit",
        "stop",
        "review",
      ]),
    })
    .strict(),
]);
export type JsonSessionOutput =
  | { type: "relay.session"; sessionId: string; version: 2; agent: string }
  | { type: "relay.accepted"; sessionId: string }
  | { type: "relay.event"; event: SessionEvent }
  | {
      type: "relay.gap";
      sessionId: string;
      from: number;
      to: number;
      reason: string;
    }
  | {
      type: "relay.readonly";
      command: string;
      result: unknown;
      sessionId?: string;
    }
  | { type: "relay.error"; message: string; phase?: string };
export const jsonReplaySchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z.array(sessionEventSchema),
  gap: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      reason: z.literal("retention"),
    })
    .optional(),
});
