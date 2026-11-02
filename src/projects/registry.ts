import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "../storage/files.js";

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
  validateId(id);
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error("项目根必须是目录");
  await writeJson(join(home, "projects", `${id}.json`), { root });
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
