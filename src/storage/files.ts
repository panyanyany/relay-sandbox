import { withFinalizer } from "./finalize.js";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  appendFile,
  link,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// 原子替换元数据，禁止其他用户读取任务凭据关联信息。
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
// 排他锁先写完再用硬链接发布；错误示范：直接 wx 写目标会短暂暴露空 JSON。
export async function writeExclusiveJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await withFinalizer(
    () => link(temp, path),
    () => unlink(temp),
  );
}
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
// 日志在宿主任务目录中追加，不给内层写权限。
export async function appendEvent(path: string, event: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(event) + "\n", { mode: 0o600 });
}
