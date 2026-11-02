import { posix } from "node:path";
import { DECOY_DIRECTORY, type DecoyManifest } from "./manifest.js";

export interface PlacementInventory {
  // existingPaths 是普通文件/特殊端点，不应包含可正常使用的已有目录。
  existingPaths?: string[];
  symlinkPaths?: string[];
  // 调用方将真实任务配置、授权资源用途冲突路径放在这里。
  conflictingPaths?: string[];
}
export interface DecoyPlacement {
  files: { id: string; path: string; content: string; mode: number }[];
  summary: {
    id: string;
    path: string;
    status: "planned" | "skipped";
    reason?: string;
  }[];
}

// 等于或位于目录下面；固定边界分隔符避免 /foo 匹配 /foobar。
function contains(parent: string, child: string) {
  return (
    parent === child || child.startsWith(`${parent === "/" ? "" : parent}/`)
  );
}

// 只返回容器目标及内容，不访问或开放任意宿主路径；上传方负责再次无覆盖检查。
export function planPlacement(
  manifest: DecoyManifest,
  inventory: PlacementInventory = {},
): DecoyPlacement {
  const result: DecoyPlacement = { files: [], summary: [] };
  if (!manifest.enabled) return result;
  for (const entry of manifest.entries) {
    if (
      posix.dirname(entry.path) !== DECOY_DIRECTORY ||
      posix.normalize(entry.path) !== entry.path
    ) {
      throw new Error("诱饵只能投放到独立目录");
    }
    let reason: string | undefined;
    if (inventory.symlinkPaths?.some((path) => contains(path, entry.path)))
      reason = "symlink-path";
    else if (
      inventory.existingPaths?.some((path) => contains(path, entry.path))
    )
      reason = "existing-path";
    else if (
      inventory.conflictingPaths?.some(
        (path) => contains(path, entry.path) || contains(entry.path, path),
      )
    )
      reason = "configuration-conflict";
    if (reason) {
      result.summary.push({
        id: entry.id,
        path: entry.path,
        status: "skipped",
        reason,
      });
      continue;
    }
    // 独立JSON而非默认凭据文件：不改变SDK凭据发现或环境变量选择。
    result.files.push({
      id: entry.id,
      path: entry.path,
      mode: 0o600,
      content:
        JSON.stringify({
          profile: "relay-sandbox-decoy",
          provider: entry.provider,
          credential: entry.value,
        }) + "\n",
    });
    result.summary.push({ id: entry.id, path: entry.path, status: "planned" });
  }
  return result;
}
