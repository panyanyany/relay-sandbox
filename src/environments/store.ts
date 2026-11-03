import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateId } from "../projects/registry.js";
import { readJson, writeJson } from "../storage/files.js";
import { withFinalizer } from "../storage/finalize.js";

// 环境身份独立于任务；活动借用者是唯一可操作开发容器的任务。
export const environmentSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    projectId: z.string(),
    signature: z.string(),
    mode: z.enum(["persistent", "ttl"]),
    idleRetentionHours: z.number().positive(),
    activeTaskId: z.string().optional(),
    lastTaskId: z.string().optional(),
    containerId: z.string().optional(),
    networkId: z.string().optional(),
    idleSince: z.string().optional(),
    createdAt: z.string(),
    needsReset: z.boolean().optional(),
  })
  .strict();
export type ProjectEnvironment = z.infer<typeof environmentSchema>;
export function environmentPath(home: string, projectId: string) {
  validateId(projectId);
  return join(home, "environments", projectId);
}
export async function readEnvironment(home: string, projectId: string) {
  try {
    const value = environmentSchema.parse(
      await readJson(
        join(environmentPath(home, projectId), "environment.json"),
      ),
    );
    validateId(value.id);
    if (value.projectId !== projectId) throw new Error("项目环境归属不一致");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function saveEnvironment(home: string, value: ProjectEnvironment) {
  await writeJson(
    join(environmentPath(home, value.projectId), "environment.json"),
    environmentSchema.parse(value),
  );
}
// 与现有应用锁相同的排他文件语义；不猜测锁已过期，也不覆盖并发创建。
export async function withEnvironmentLock<T>(
  home: string,
  projectId: string,
  operation: () => Promise<T>,
) {
  const root = environmentPath(home, projectId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "operation.lock");
  try {
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "项目环境正在操作；若控制进程崩溃，请核对后移除环境 operation.lock",
        { cause: error },
      );
    throw error;
  }
  return withFinalizer(operation, () => unlink(lock));
}
