import { readFile } from "node:fs/promises";
import type Docker from "dockerode";
import { z } from "zod";
import { execute } from "../docker/execute.js";
import type { DecoyManifest } from "./manifest.js";
import { planPlacement } from "./placement.js";

const summarySchema = z.array(
  z
    .object({
      id: z.string(),
      path: z.string(),
      status: z.enum(["installed", "skipped"]),
      reason: z.string().optional(),
    })
    .strict(),
);
export type PlacementSummary = z.infer<typeof summarySchema>[number];

// 内容只作为私有 exec 载荷；执行结果经严格校验，不保存原值或异常输出。
export async function installDecoys(
  docker: Docker,
  containerId: string,
  manifest: DecoyManifest,
): Promise<PlacementSummary[]> {
  const plan = planPlacement(manifest);
  if (!plan.files.length) return [];
  const script = await readFile(
    new URL("../../scripts/decoy-install.py", import.meta.url),
    "utf8",
  );
  const result = await execute(
    docker,
    containerId,
    ["python3", "-c", script, JSON.stringify(plan.files)],
    {},
    10000,
    16384,
    manifest.entries.map((entry) => entry.value),
  ).catch(() => {
    // Docker 错误不透传私有 exec 参数，用户只看到固定组件错误。
    throw new Error("容器诱饵安装执行失败");
  });
  if (result.exitCode !== 0 || result.truncated)
    throw new Error("容器诱饵安装失败");
  let summary: PlacementSummary[];
  try {
    summary = summarySchema.parse(JSON.parse(result.output));
  } catch {
    throw new Error("容器诱饵安装结果格式无效");
  }
  if (
    summary.length !== plan.files.length ||
    summary.some((entry, index) => {
      const expected = plan.files[index]!;
      return (
        entry.id !== expected.id ||
        entry.path !== expected.path ||
        (entry.reason !== undefined &&
          ![
            "existing-path",
            "symlink-or-nondirectory",
            "permission-denied",
          ].includes(entry.reason))
      );
    })
  )
    throw new Error("容器诱饵安装结果与清单不符");
  return summary;
}
