import { readdir, lstat, readlink, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import picomatch from "picomatch";
import { digest } from "../storage/hash.js";
export interface Entry {
  path: string;
  type: "file" | "symlink" | "directory";
  mode: number;
  hash: string;
  size: number;
  link?: string;
}
export type Manifest = Entry[];
export function manifestDigest(manifest: Manifest): string {
  return digest(JSON.stringify(manifest));
}
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
// 普通文件通过 O_NOFOLLOW 打开，前后元数据变化时立即失败，避免生成混合快照。
export async function readStable(root: string, path: string): Promise<Buffer> {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`文件路径非法: ${path}`);
  let parent = await open(
    await realpath(root),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    // Linux procfd 固定已打开的父目录，逐层 O_NOFOLLOW，拒绝祖先链接竞态。
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.close();
      parent = next;
    }
    const fd = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await fd.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`不支持的文件: ${path}`);
      const data = await fd.readFile(),
        after = await fd.stat({ bigint: true });
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error(`复制期间文件变化: ${path}`);
      return data;
    } finally {
      await fd.close();
    }
  } finally {
    await parent.close();
  }
}
// 不使用 Git 忽略规则，目录排除显式匹配自身及其后代。
export async function scan(
  root: string,
  exclude: string[] = [],
): Promise<Manifest> {
  const match = picomatch(
    exclude.flatMap((p) => [
      p.replace(/\/$/, ""),
      `${p.replace(/\/$/, "")}/**`,
    ]),
    { dot: true },
  );
  const result: Manifest = [];
  async function visit(dir: string): Promise<void> {
    for (const item of (await readdir(join(root, dir))).sort()) {
      const path = dir ? `${dir}/${item}` : item;
      if (match(path)) continue;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        result.push({
          path,
          type: "directory",
          mode: info.mode & 0o777,
          hash: digest(""),
          size: 0,
        });
        await visit(path);
        continue;
      }
      if (info.isSymbolicLink()) {
        const link = await readlink(join(root, path));
        result.push({
          path,
          type: "symlink",
          mode: info.mode & 0o777,
          hash: digest(link),
          size: Buffer.byteLength(link),
          link,
        });
        continue;
      }
      if (!info.isFile())
        throw new Error(`不支持的文件类型，请显式排除: ${path}`);
      const data = await readStable(root, path);
      result.push({
        path,
        type: "file",
        mode: info.mode & 0o777,
        hash: digest(data),
        size: data.length,
      });
    }
  }
  await visit("");
  return result;
}
