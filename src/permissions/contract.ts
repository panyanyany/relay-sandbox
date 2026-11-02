import { z } from "zod";
import { hostPermissionsSchema } from "./schema.js";

// 冻结写入、恢复及公开摘要使用同一容量和结构契约（含格式化换行）。
export const POLICY_MAX_BYTES = 64 * 1024;
export const frozenPolicySchema = hostPermissionsSchema.extend({
  schemaVersion: z.literal(1),
});
export function serializePolicy(value: unknown): string {
  const text = JSON.stringify(frozenPolicySchema.parse(value), null, 2) + "\n";
  if (Buffer.byteLength(text) > POLICY_MAX_BYTES)
    throw new Error("授权快照超过64KiB限制，请缩小授权配置");
  return text;
}
