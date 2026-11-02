import { lchown, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileResource } from "../permissions/types.js";
import { inside } from "../workspace/manifest.js";
import { copyResources } from "./copy.js";
import { validateResources } from "./paths.js";
import { resourceMounts } from "./mounts.js";

// 不能通过一个可写父资源替换另一个授权源；副本与直接资源也采用相同约束。
function rejectOverlappingSources(resources: FileResource[]): void {
  for (const resource of resources)
    if (
      resources.some(
        (other) =>
          other !== resource &&
          (inside(resource.source, other.source) ||
            inside(other.source, resource.source)),
      )
    )
      throw new Error(`资源源相互重叠: ${resource.name}`);
}
// 仅调整任务副本的所有者，不改变宿主授权源权限；链接出现时明确失败。
async function ownCopy(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("资源副本包含链接");
  if (info.isDirectory())
    for (const name of await readdir(path)) await ownCopy(join(path, name));
  await lchown(path, 1000, 1000);
}
// 新任务只复制一次，返回 source 已改写的实际挂载资源；报告仍使用冻结原授权。
export async function prepareResources(
  resources: FileResource[],
  privateRoot: string,
  protectedRoots: string[] = [],
) {
  rejectOverlappingSources(resources);
  const prepared = await copyResources(resources, privateRoot, protectedRoots);
  for (const resource of prepared)
    if (resource.mode === "copy") await ownCopy(resource.source);
  return { resources: prepared, mounts: resourceMounts(prepared) };
}
// 后续候选检查复用原任务副本，不重读或覆盖宿主副本源。
export async function loadPreparedResources(
  frozen: FileResource[],
  privateRoot: string,
  protectedRoots: string[] = [],
) {
  rejectOverlappingSources(frozen);
  const resources: FileResource[] = [];
  for (const resource of frozen) {
    const prepared =
      resource.mode === "copy"
        ? { ...resource, source: join(privateRoot, resource.name) }
        : resource;
    const [validated] = await validateResources(
      [prepared],
      resource.mode === "copy" ? [] : protectedRoots,
    );
    resources.push(validated!);
  }
  // 再验证共同目标冲突；保护目录只针对原授权源，副本按冻结私有路径定位。
  await validateResources(resources);
  return { resources, mounts: resourceMounts(resources) };
}
