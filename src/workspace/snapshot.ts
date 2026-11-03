import { mkdir, open, symlink, lstat, readFile, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { scan, inside, type Manifest } from "./manifest.js";
import { hashStable } from "./stable-file.js";

// 首版拒绝外部 Git 管理引用，而不是将宿主管理目录复制进内层。
async function validateGit(root: string): Promise<void> {
  let info;
  try {
    info = await lstat(join(root, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      "暂不支持 worktree 或链接 .git；请显式排除 .git 或使用自包含仓库",
    );
  for (const name of ["commondir", "objects/info/alternates"]) {
    try {
      await readFile(join(root, ".git", name));
      throw new Error(`不允许外部 Git 引用: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
// 每个文件重新核对摘要，确保副本与持久基线一致。
export async function snapshot(
  root: string,
  dest: string,
  exclude: string[],
  maxFileBytes = Infinity,
  signal?: AbortSignal,
): Promise<Manifest> {
  signal?.throwIfAborted();
  if (inside(resolve(root), resolve(dest)))
    throw new Error("任务目录不能位于原项目内");
  if (!exclude.includes(".git") && !exclude.includes(".git/**"))
    await validateGit(root);
  const manifest = await scan(root, exclude, maxFileBytes, signal);
  await mkdir(dest, { recursive: true, mode: 0o700 });
  for (const entry of manifest) {
    signal?.throwIfAborted();
    const target = join(dest, entry.path);
    await mkdir(dirname(target), { recursive: true });
    if (entry.type === "directory") {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (entry.type === "symlink") {
      await symlink(entry.link!, target);
      continue;
    }
    const output = await open(target, "wx", entry.mode);
    try {
      const copied = await hashStable(
        root,
        entry.path,
        async (chunk) => {
          await output.writeFile(chunk);
        },
        maxFileBytes,
        signal,
      );
      if (copied.hash !== entry.hash)
        throw new Error(`复制期间内容变化: ${entry.path}`);
    } finally {
      await output.close();
    }
  }
  for (const entry of [...manifest].reverse())
    if (entry.type === "directory")
      await chmod(join(dest, entry.path), entry.mode);
  if (
    JSON.stringify(await scan(root, exclude, maxFileBytes, signal)) !==
    JSON.stringify(manifest)
  )
    throw new Error("复制期间项目发生变化，请重新创建任务");
  return manifest;
}
