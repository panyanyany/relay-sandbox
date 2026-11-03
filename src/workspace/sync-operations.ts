import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import { execute } from "../docker/execute.js";
import { upload } from "../docker/archive.js";

// 共用 Git 管理目录规则；缺少源目录才表示项目未使用 Git。
export async function replaceGitDirectory(host: string, candidate: string) {
  await rm(join(candidate, ".git"), { recursive: true, force: true });
  try {
    await stat(join(host, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await cp(join(host, ".git"), join(candidate, ".git"), {
    recursive: true,
    verbatimSymlinks: true,
  });
}

// 写入前由调用者保存现场和未完成标记，失败不伪装成已回滚。
export async function replaceRuntimeWorkspace(
  docker: Docker,
  id: string,
  candidate: string,
) {
  const result = await execute(
    docker,
    id,
    [
      "/usr/bin/find",
      "/workspace",
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-exec",
      "/bin/rm",
      "-rf",
      "--",
      "{}",
      "+",
    ],
    {},
    30000,
    4096,
  );
  if (result.exitCode !== 0) throw new Error("工作区清理失败，须保留现场检查");
  await upload(docker, id, candidate);
}

// 无宿主业务变化时只重置 Git 管理目录，不导出或重传整个容器工作区。
export async function resetRuntimeGit(
  docker: Docker,
  id: string,
  host: string,
  stage: string,
) {
  const gitRoot = join(stage, "git-only");
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  await replaceGitDirectory(host, gitRoot);
  const result = await execute(
    docker,
    id,
    ["/bin/rm", "-rf", "--", "/workspace/.git"],
    {},
    30000,
    4096,
  );
  if (result.exitCode !== 0) throw new Error("Git 管理目录清理失败");
  await upload(docker, id, gitRoot);
}

// 完整副本准备好后再更换目标，避免复制阶段先破坏旧基线。
export async function replaceHostBaseline(host: string, destination: string) {
  const next = `${destination}-next`;
  await rm(next, { recursive: true, force: true });
  await cp(host, next, { recursive: true, verbatimSymlinks: true });
  await rm(destination, { recursive: true, force: true });
  await rename(next, destination);
}
