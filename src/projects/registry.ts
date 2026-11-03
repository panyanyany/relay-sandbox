import { withProjectSetupLock } from "./lock.js";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "../storage/files.js";

interface ProjectEntry {
  root: string;
  projectId?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
    throw new Error("标识只允许字母、数字、下划线和短横线");
}
// 项目注册是宿主显式操作；MCP 创建任务只能引用已注册标识。
export async function registerProject(
  home: string,
  id: string,
  path: string,
): Promise<void> {
  return withProjectSetupLock(home, id, () =>
    registerProjectLocked(home, id, path),
  );
}
// 仅供已持有项目配置锁的调用链使用，避免嵌套加锁。
export async function registerProjectLocked(
  home: string,
  id: string,
  path: string,
): Promise<void> {
  validateId(id);
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error("项目根必须是目录");
  const entryPath = join(home, "projects", `${id}.json`);
  const existing = await registeredProject(home, id);
  const now = new Date().toISOString();
  await writeJson(entryPath, {
    projectId: id,
    root,
    // 旧注册文件没有历史时间，保留未知值，不能把迁移时间冒充创建时间。
    createdAt: existing ? (existing.createdAt ?? null) : now,
    updatedAt: now,
  });
}
export async function resolveProject(
  home: string,
  id: string,
): Promise<string> {
  validateId(id);
  const entry = await readJson<{ root: string }>(
    join(home, "projects", `${id}.json`),
  );
  return realpath(entry.root);
}

// 向配置入口提供统一元数据；历史文件按需读取，无需批量迁移。
export async function projectMetadata(home: string, id: string) {
  validateId(id);
  const entry = await readJson<ProjectEntry>(
    join(home, "projects", `${id}.json`),
  );
  return {
    projectId: id,
    root: await realpath(entry.root),
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  };
}

// 只捕获注册文件本身不存在；不能把实际目录缺失当成未注册。
export async function registeredProject(
  home: string,
  id: string,
): Promise<ProjectEntry | undefined> {
  validateId(id);
  try {
    return await readJson<ProjectEntry>(join(home, "projects", `${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
