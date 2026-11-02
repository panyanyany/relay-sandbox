import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  frozenPolicySchema as frozenSchema,
  serializePolicy,
} from "./contract.js";
import { digest } from "../storage/hash.js";
import { taskPath } from "../tasks/store.js";
import { hostPermissionsSchema } from "./schema.js";
import type { FrozenPolicy, HostPermissions } from "./types.js";

// 规范化后计算摘要，避免对象键插入顺序改变同一策略的审核绑定。
export function policyDigest(policy: FrozenPolicy): string {
  return digest(JSON.stringify(frozenSchema.parse(policy)));
}
// 只有确实没有快照才表示旧任务；损坏或不支持的快照不能隐式扩权。
export async function readFrozenPolicy(
  home: string,
  id: string,
): Promise<FrozenPolicy | undefined> {
  let text: string;
  try {
    text = await readFile(join(taskPath(home, id), "policy.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return frozenSchema.parse(JSON.parse(text));
}
// 原子发布完整快照，已有值只允许幂等读取，不能被并发创建或恢复覆盖。
export async function freezePolicy(
  home: string,
  id: string,
  policy: HostPermissions,
): Promise<FrozenPolicy> {
  const frozen = frozenSchema.parse({
    ...hostPermissionsSchema.parse(policy),
    schemaVersion: 1,
  });
  const serialized = serializePolicy(frozen);
  const root = taskPath(home, id),
    target = join(root, "policy.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `policy-${randomUUID()}.tmp`);
  await writeFile(temp, serialized, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFrozenPolicy(home, id);
      if (!existing || policyDigest(existing) !== policyDigest(frozen))
        throw new Error("任务策略已冻结，不能覆盖不同授权");
      return existing;
    }
    return frozen;
  } finally {
    await unlink(temp);
  }
}
