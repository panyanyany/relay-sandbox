import { ExportBudget } from "./export-budget.js";
import { constants } from "node:fs";
import { copyFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_EXPORT_FILE_BYTES } from "../workspace/stable-file.js";

// tar硬链接目标相对归档根，不相对条目所在目录；保留路径检查而非normalize吞掉越界。
export function archivePath(value: string): string {
  const path = value
    .replace(/^(?:workspace|\.)(?:\/|$)/, "")
    .replace(/\/$/, "");
  if (
    value.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`归档路径非法: ${value}`);
  return path;
}
export interface ArchiveEntry {
  type: string;
  target?: string;
}

// 先解析全部目标再复制，支持前向引用；只使用已验证的归档内普通文件，不创建宿主硬链接。
export async function materializeLinks(
  root: string,
  entries: Map<string, ArchiveEntry>,
  budget = new ExportBudget(),
) {
  const resolved = new Map<string, string>();
  for (const [name, entry] of entries) {
    if (entry.type !== "link") continue;
    let current = name;
    const chain = new Set<string>();
    while (!resolved.has(current)) {
      if (chain.has(current))
        throw new Error(`归档硬链接循环: ${name} -> ${current}`);
      chain.add(current);
      const target = entries.get(current);
      if (target?.type === "file") break;
      if (target?.type !== "link" || !target.target)
        throw new Error(`归档硬链接目标不是普通文件: ${name} -> ${current}`);
      current = target.target;
    }
    const source = resolved.get(current) ?? current;
    for (const item of chain) resolved.set(item, source);
  }
  const copies: { source: string; destination: string }[] = [];
  for (const [name, entry] of entries) {
    if (entry.type !== "link") continue;
    const source = join(root, resolved.get(name)!);
    const info = await lstat(source);
    if (!info.isFile() || info.size > MAX_EXPORT_FILE_BYTES)
      throw new Error(
        `归档硬链接目标类型或大小非法: ${name} -> ${entry.target}`,
      );
    budget.reserve(info.size);
    copies.push({ source, destination: join(root, name) });
  }
  // 全部展开预算通过后再复制，避免大批副本写到一半才发现已知超限。
  for (const { source, destination } of copies) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}
