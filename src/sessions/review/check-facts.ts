import { join } from "node:path";
import { z } from "zod";
import { readJson, writeExclusiveJson } from "../../storage/files.js";
import { digest } from "../../storage/hash.js";
import type { ReviewEvidence } from "./evidence.js";
import type { Config } from "../../config/schema.js";
const factsSchema = z
  .object({
    version: z.literal(1),
    evidenceId: z.string(),
    codeDigest: z.string(),
    configDigest: z.string(),
    checksDigest: z.string(),
    results: z.array(z.json()),
  })
  .strict();
// 固定检查事实与模型调用分开保存，模型失败后不重新读取当前开发资源。
export async function fixedCheckFacts(
  evidence: Pick<ReviewEvidence, "root" | "id" | "codeDigest" | "configDigest">,
  checks: Config["delivery"]["checks"],
  run?: () => Promise<unknown[]>,
) {
  const path = join(evidence.root, "check-facts.json");
  const binding = {
    version: 1 as const,
    evidenceId: evidence.id,
    codeDigest: evidence.codeDigest,
    configDigest: evidence.configDigest,
    checksDigest: digest(JSON.stringify(checks)),
  };
  try {
    const facts = factsSchema.parse(await readJson(path));
    for (const key of [
      "evidenceId",
      "codeDigest",
      "configDigest",
      "checksDigest",
    ] as const)
      if (facts[key] !== binding[key]) throw new Error("固定检查事实绑定不符");
    return facts.results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!run)
    throw new Error("固定证据尚无检查事实，且缺少隔离检查执行器；审查未完成");
  const facts = factsSchema.parse({ ...binding, results: await run() });
  await writeExclusiveJson(path, facts);
  return facts.results;
}
