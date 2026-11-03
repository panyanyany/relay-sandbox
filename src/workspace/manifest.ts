import { readdir, lstat, readlink } from "node:fs/promises";
import { hashStable } from "./stable-file.js";
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
export { readStable } from "./stable-file.js";
// 不使用 Git 忽略规则，目录排除显式匹配自身及其后代。
export async function scan(
  root: string,
  exclude: string[] = [],
  maxFileBytes = Infinity,
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
      const data = await hashStable(root, path, undefined, maxFileBytes);
      result.push({
        path,
        type: "file",
        mode: info.mode & 0o777,
        hash: data.hash,
        size: data.size,
      });
    }
  }
  await visit("");
  return result;
}
