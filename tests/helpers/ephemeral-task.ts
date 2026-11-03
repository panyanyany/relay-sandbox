import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createTask } from "../../src/tasks/create.js";
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
export async function createEphemeralTask(
  home: string,
  projectId: string,
  prompt: string,
) {
  await configureEphemeralProject(await resolveProject(home, projectId));
  return createTask(home, projectId, prompt);
}
