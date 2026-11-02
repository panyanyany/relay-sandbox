import { z } from "zod";

// 写盘前严格筛选字段：目标只有主机，不允许完整URL、请求片段或凭据。
export const trafficEventSchema = z
  .object({
    time: z.iso.datetime({ offset: true }),
    host: z.string().regex(/^[A-Za-z0-9._:\[\]-]{1,253}$/),
    port: z.number().int().min(1).max(65535),
    decoyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    encoding: z.enum(["raw", "url-percent", "base64", "base64url"]),
    location: z.enum(["target", "header", "body"]),
  })
  .strict();

// 缺口说明观察范围；无命中不能解释为无外传或远端未收到。
export const trafficGapSchema = z
  .object({
    reason: z.enum(["size-limit", "unsupported-content-encoding"]),
    location: z.enum(["target", "header", "body"]),
  })
  .strict();
export const trafficMatchResultSchema = z
  .object({
    events: z.array(trafficEventSchema).max(512),
    gaps: z.array(trafficGapSchema).max(2),
  })
  .strict();
export type TrafficEvent = z.infer<typeof trafficEventSchema>;
export type TrafficGap = z.infer<typeof trafficGapSchema>;
export type TrafficMatchResult = z.infer<typeof trafficMatchResultSchema>;
