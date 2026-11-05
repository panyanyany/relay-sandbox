import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateId } from "../projects/registry.js";
import { hostPermissionsSchema } from "./schema.js";
import type { HostPermissions } from "./types.js";

// 项目只引用资源名称，真实源路径及权限始终来自宿主专用配置。
export async function loadHostPermissions(
  home: string,
  projectId: string,
  requests?: string[],
): Promise<HostPermissions> {
  validateId(projectId);
  let value: unknown;
  try {
    value = parse(
      await readFile(join(home, "permissions", `${projectId}.yaml`), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    value = {};
  }
  const policy = hostPermissionsSchema.parse(value);
  // 仅为新任务解析默认值；旧冻结快照仍由访问模块按隔离模式读取。
  policy.project ??= { mode: "direct" };
  if (requests === undefined) return policy;
  const available = new Set(policy.resources.map((resource) => resource.name));
  for (const name of requests) {
    validateId(name);
    if (!available.has(name)) throw new Error(`项目请求了未授权资源：${name}`);
  }
  const selected = new Set(requests);
  return {
    ...policy,
    resources: policy.resources.filter((resource) =>
      selected.has(resource.name),
    ),
  };
}
