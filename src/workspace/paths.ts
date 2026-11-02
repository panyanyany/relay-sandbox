import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

// 候选目录只由宿主操作；逐层拒绝符号链接，避免用户并发改动导致写出候选。
export async function candidatePath(
  root: string,
  path: string,
): Promise<string> {
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === ".git"
  ) {
    throw new Error(`不安全的候选路径: ${path}`);
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`候选父路径不是目录: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(parent);
    }
  }
  return join(root, path);
}
