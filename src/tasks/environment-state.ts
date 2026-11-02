import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateId } from "../projects/registry.js";
import { writeJson } from "../storage/files.js";
import type { TrafficHandle } from "../traffic/runtime.js";
import { taskPath } from "./store.js";

// 版本化环境记录的唯一结构契约，持久化和报告读取共同使用，避免字段漂移。
export const environmentSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: z.string(),
    containerId: z.string().min(1),
    role: z.enum(["main", "check"]),
    enabled: z.boolean(),
    traffic: z.enum([
      "disabled",
      "ready",
      "unavailable",
      "stopped",
      "cleanup_pending",
    ]),
    placements: z.array(
      z
        .object({
          id: z.string(),
          path: z.string(),
          status: z.enum(["installed", "skipped"]),
          reason: z.string().optional(),
        })
        .strict(),
    ),
    gaps: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(32),
    helperRoot: z.string().optional(),
  })
  .strict();
export type EnvironmentSummary = z.infer<typeof environmentSummarySchema>;
export type EnvironmentHandle = Pick<
  TrafficHandle,
  "containerId" | "privateDirectory"
>;
export interface EnvironmentState {
  summary: EnvironmentSummary;
  handle?: EnvironmentHandle;
}

// 所有运行时私密材料均限制在受控任务目录，不允许路径穿越。
export function environmentDirectory(
  home: string,
  taskId: string,
  runtimeId: string,
) {
  validateId(runtimeId);
  return join(taskPath(home, taskId), "traffic", runtimeId);
}

// 只持久化最小handle，不序列化公CA Buffer、原值或任意附加字段。
export async function saveEnvironmentState(
  home: string,
  taskId: string,
  state: EnvironmentState,
  selectMain = false,
) {
  const summary = environmentSummarySchema.parse(state.summary);
  const root = environmentDirectory(home, taskId, summary.runtimeId);
  if (
    summary.helperRoot !== undefined &&
    summary.helperRoot !== `/opt/relay-sandbox/audit/${summary.runtimeId}`
  )
    throw new Error("公开工具目录与运行时不一致");
  if (state.handle) {
    if (state.handle.privateDirectory !== root)
      throw new Error("私密代理目录与运行时不一致");
    await writeJson(join(root, "handle.json"), {
      containerId: state.handle.containerId,
      privateDirectory: root,
    });
  }
  if (!state.handle) {
    try {
      await unlink(join(root, "handle.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeJson(join(root, "summary.json"), summary);
  if (selectMain && summary.role === "main")
    await writeJson(
      join(taskPath(home, taskId), "traffic", "latest-main.json"),
      { runtimeId: summary.runtimeId },
    );
}

// 不存在是未安装；损坏数据明确抛错，不能解释成审计安全或成功。
export async function loadEnvironmentState(
  home: string,
  taskId: string,
  runtimeId: string,
): Promise<EnvironmentState | undefined> {
  const root = environmentDirectory(home, taskId, runtimeId);
  let summary: EnvironmentSummary;
  try {
    summary = environmentSummarySchema.parse(
      JSON.parse(await readFile(join(root, "summary.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    summary.runtimeId !== runtimeId ||
    (summary.helperRoot !== undefined &&
      summary.helperRoot !== `/opt/relay-sandbox/audit/${runtimeId}`)
  )
    throw new Error("运行时公开记录不一致");
  const state: EnvironmentState = { summary };
  try {
    const value = z
      .object({
        containerId: z.string().min(1),
        privateDirectory: z.literal(root),
      })
      .strict()
      .parse(JSON.parse(await readFile(join(root, "handle.json"), "utf8")));
    state.handle = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return state;
}

// latest指针只由主环境安装选择，检查环境的更新不会覆盖开发Agent入口。
export async function loadMainEnvironment(
  home: string,
  taskId: string,
): Promise<EnvironmentState | undefined> {
  let pointer: { runtimeId: string };
  try {
    pointer = z
      .object({ runtimeId: z.string() })
      .strict()
      .parse(
        JSON.parse(
          await readFile(
            join(taskPath(home, taskId), "traffic", "latest-main.json"),
            "utf8",
          ),
        ),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = await loadEnvironmentState(home, taskId, pointer.runtimeId);
  if (state && state.summary.role !== "main")
    throw new Error("主环境指针不能引用检查环境");
  return state;
}

// 供监督、清理和报告枚举已提交的环境记录；未提交目录由任务资源清理回收。
export async function listEnvironments(
  home: string,
  taskId: string,
): Promise<EnvironmentState[]> {
  let entries;
  try {
    entries = await readdir(join(taskPath(home, taskId), "traffic"), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states: EnvironmentState[] = [];
  for (const entry of entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const state = await loadEnvironmentState(home, taskId, entry.name);
    if (state) states.push(state);
  }
  return states;
}
