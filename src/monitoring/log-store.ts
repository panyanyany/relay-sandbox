import {
  mkdir,
  stat,
  rename,
  unlink,
  appendFile,
  readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
export interface LogPolicy {
  maxFileBytes: number;
  maxFiles: number;
  retentionDays: number;
}
// 只忽略预期的缺失文件，磁盘满、权限等错误必须向上传递。
async function remove(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function size(path: string) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return 0;
  }
}
// 当前文件加归档总计不超过 maxFiles；调用方保证同一个日志只有一个写入者。
export async function appendBoundedLog(
  path: string,
  value: unknown,
  policy: LogPolicy,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > policy.maxFileBytes)
    throw new Error("单条日志超出文件容量上限");
  if ((await size(path)) + Buffer.byteLength(line) > policy.maxFileBytes) {
    await remove(
      policy.maxFiles === 1 ? path : `${path}.${policy.maxFiles - 1}`,
    );
    for (let index = policy.maxFiles - 2; index >= 0; index--) {
      const source = index === 0 ? path : `${path}.${index}`;
      try {
        await rename(source, `${path}.${index + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  await appendFile(path, line, { mode: 0o600 });
}
// 定期按修改时间清除指标归档；路径只来自宿主固定目录，不跟随链接。
export async function pruneTelemetry(
  directory: string,
  retentionDays: number,
  now = Date.now(),
  dryRun = false,
) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names.filter((n) =>
    /^(?:samples\.jsonl(?:\.\d+)?|latest\.json)$/.test(n),
  )) {
    const path = join(directory, name);
    try {
      if ((await stat(path)).mtimeMs + retentionDays * 86400000 <= now) {
        if (!dryRun) await unlink(path);
        removed.push(name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
