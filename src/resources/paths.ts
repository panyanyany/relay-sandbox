import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { FileResource } from "../permissions/types.js";
import { fileResourceSchema } from "../permissions/schema.js";
import { inside } from "../workspace/manifest.js";

const reservedTargets = [
  "/workspace",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/opt/relay",
  "/opt/relay-sandbox",
  "/home/node/.config/relay-sandbox",
];
const reservedSources = ["/proc", "/sys", "/dev", "/run"];
function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}
// mountinfo 的路径使用八进制转义，必须还原后再比较挂载边界。
function mountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 8)),
  );
}
// 逐层拒绝符号链接；canonical 不等于原路径时不能悄悄扩大授权。
async function canonicalDirectory(source: string): Promise<string> {
  if (!isAbsolute(source) || normalize(source) !== source)
    throw new Error(`资源源路径必须规范且绝对: ${source}`);
  if ((await realpath(source)) !== source)
    throw new Error(`资源源路径包含符号链接: ${source}`);
  if (!(await lstat(source)).isDirectory())
    throw new Error(`资源源必须是目录: ${source}`);
  return source;
}
// 额外资源不沿链接、硬链接或子挂载读取授权范围外的数据。
async function validateTree(root: string): Promise<void> {
  const device = (await lstat(root)).dev;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`资源包含符号链接: ${path}`);
    if (info.dev !== device) throw new Error(`资源包含跨设备挂载: ${path}`);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(join(path, child));
    } else if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`资源包含特殊文件或硬链接: ${path}`);
    }
  }
  await visit(root);
}
// 调用者传入宿主状态目录及原项目，禁止授权源覆盖可信控制面。
export async function validateResources(
  resources: FileResource[],
  protectedRoots: string[] = [],
): Promise<FileResource[]> {
  const validated = resources.map((resource) =>
    fileResourceSchema.parse(resource),
  );
  const protectedPaths = await Promise.all(
    protectedRoots.map((path) => realpath(path)),
  );
  const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
    .trim()
    .split("\n")
    .map((line) => mountPath(line.split(" ")[4]!));
  const names = new Set<string>();
  for (const resource of validated) {
    if (names.has(resource.name))
      throw new Error(`资源名称重复: ${resource.name}`);
    names.add(resource.name);
    if (reservedTargets.some((path) => overlaps(path, resource.target)))
      throw new Error(`资源目标覆盖系统或任务控制目录: ${resource.target}`);
    if (
      validated.some(
        (other) =>
          other !== resource && overlaps(other.target, resource.target),
      )
    )
      throw new Error(`资源目标重叠: ${resource.target}`);
    resource.source = await canonicalDirectory(resource.source);
    if (
      [...reservedSources, ...protectedPaths].some((path) =>
        overlaps(path, resource.source),
      )
    )
      throw new Error(`资源源覆盖系统或宿主控制目录: ${resource.source}`);
    if (
      mounts.some(
        (path) => path !== resource.source && inside(resource.source, path),
      )
    )
      throw new Error(`资源包含子挂载: ${resource.source}`);
    await validateTree(resource.source);
  }
  return validated;
}
