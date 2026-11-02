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
