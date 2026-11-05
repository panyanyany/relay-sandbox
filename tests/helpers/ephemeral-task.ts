import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createTask } from "../../src/tasks/create.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { resolveProject } from "../../src/projects/registry.js";

// 既有一次性容器验收显式选择临时模式；默认持久化由独立跨任务用例验证。
export async function configureEphemeralProject(project: string) {
  const path = join(project, "relay-sandbox.yaml");
  let config: Record<string, unknown> = {};
  try {
    config = parse(await readFile(path, "utf8")) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(
    path,
    stringify({ ...config, environment: { mode: "ephemeral" } }),
  );
}
// 明确创建隔离副本的一次性任务；不用于验证产品默认访问模式。
export async function createIsolatedEphemeralTask(
  home: string,
  projectId: string,
  prompt: string,
) {
  await configureEphemeralProject(await resolveProject(home, projectId));
  // 既有一次性验收验证副本交付，显式选隔离；不改变已有直接模式用例。
  const path = join(home, "permissions", `${projectId}.yaml`);
  let value: unknown = {};
  try {
    value = parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const policy = hostPermissionsSchema.parse(value);
  policy.project ??= { mode: "isolated" };
  await mkdir(join(home, "permissions"), { recursive: true });
  await writeFile(path, stringify(policy));
  return createTask(home, projectId, prompt);
}
