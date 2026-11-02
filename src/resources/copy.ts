import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { FileResource } from "../permissions/types.js";
import { digest } from "../storage/hash.js";
import { inside, readStable, scan } from "../workspace/manifest.js";
import { validateResources } from "./paths.js";

// 创建前核对最近已有祖先，避免 mkdir 经链接在任务目录外留下内容。
async function validateDestination(path: string): Promise<void> {
  try {
    if ((await realpath(path)) !== path)
      throw new Error("资源副本目录的祖先包含符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await validateDestination(dirname(path));
  }
}

// 副本只写任务私有目录；失败保留现场给任务清理，不触碰授权源。
export async function copyResources(
  resources: FileResource[],
  privateRoot: string,
  protectedRoots: string[] = [],
): Promise<FileResource[]> {
  const validated = await validateResources(resources, protectedRoots);
  if (!isAbsolute(privateRoot) || normalize(privateRoot) !== privateRoot)
    throw new Error("资源副本目录必须是规范绝对路径");
  if (
    validated.some(
      (resource) =>
        inside(resource.source, privateRoot) ||
        inside(privateRoot, resource.source),
    )
  )
    throw new Error("资源副本目录不能与授权源重叠");
  await validateDestination(privateRoot);
  await mkdir(privateRoot, { mode: 0o700, recursive: true });
  if ((await realpath(privateRoot)) !== privateRoot)
    throw new Error("资源副本目录必须是规范且无链接的绝对路径");
  const result: FileResource[] = [];
  for (const resource of validated) {
    if (resource.mode === "direct") {
      result.push(resource);
      continue;
    }
    const destination = join(privateRoot, resource.name);
    // 不复用旧目录，避免遗留文件进入新任务授权。
    await mkdir(destination, { mode: 0o700 });
    const manifest = await scan(resource.source);
    for (const entry of manifest) {
      const target = join(destination, entry.path);
      if (entry.type === "symlink")
        throw new Error(`复制期间出现链接: ${entry.path}`);
      await mkdir(dirname(target), { recursive: true });
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true });
      } else {
        const data = await readStable(resource.source, entry.path);
        if (digest(data) !== entry.hash)
          throw new Error(`复制期间资源变化: ${entry.path}`);
        await writeFile(target, data, { flag: "wx", mode: entry.mode });
      }
    }
    // 再次检查文件类型、挂载和摘要，拒绝复制中发生的可见变化。
    await validateResources([resource], protectedRoots);
    if (
      JSON.stringify(await scan(resource.source)) !== JSON.stringify(manifest)
    )
      throw new Error(`复制期间资源变化: ${resource.name}`);
    for (const entry of [...manifest].reverse())
      if (entry.type === "directory")
        await chmod(join(destination, entry.path), entry.mode);
    result.push({ ...resource, source: destination });
  }
  return result;
}
