import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJson } from "../storage/files.js";
import {
  assertSessionOperation,
  type SessionOperationLease,
} from "./operation.js";

const stateSchema = z
  .object({
    evidenceVersion: z.number().int().nonnegative(),
    reviewedVersion: z.number().int().nonnegative().optional(),
    phase: z.enum(["idle", "busy", "interrupted"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type SessionState = z.infer<typeof stateSchema>;
function statePath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "state.json");
}
const failureSchema = z
  .object({
    error: z.string(),
    evidenceVersion: z.number().int().nonnegative(),
  })
  .strict();
function failurePath(home: string, id: string) {
  return join(home, "sessions", z.uuid().parse(id), "backend-failure.json");
}
// 独立后端故障事实不抢占审查租约；迟到的正常完成不能清除此事实。
export async function recordBackendFailure(
  home: string,
  id: string,
  error: string,
) {
  const state = await readSessionState(home, id);
  await writeJson(failurePath(home, id), {
    error,
    evidenceVersion: state.evidenceVersion + 1,
  });
}
// 新会话没有状态文件时视为零版本；其他读取或格式错误必须上报。
export async function readSessionState(
  home: string,
  id: string,
): Promise<SessionState> {
  let state: SessionState;
  try {
    state = stateSchema.parse(await readJson(statePath(home, id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { evidenceVersion: 0, phase: "idle", revision: 0 };
  }
  try {
    const failure = failureSchema.parse(await readJson(failurePath(home, id)));
    return {
      ...state,
      phase: "interrupted",
      evidenceVersion: Math.max(state.evidenceVersion, failure.evidenceVersion),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return state;
  }
}
// 只允许持锁调用方标记中断或完成当前证据的审查，版本号不能任意回退。
export async function updateSessionState(
  home: string,
  id: string,
  lease: SessionOperationLease,
  update: {
    phase?: "interrupted" | "idle";
    reviewedVersion?: number;
    invalidateEvidence?: boolean;
  },
): Promise<SessionState> {
  await assertSessionOperation(home, id, lease);
  const state = await readSessionState(home, id);
  if (update.phase === "idle" && !["prepare", "stop"].includes(lease.kind))
    throw new Error("只有恢复或停止操作可以解除中断状态");
  if (
    update.reviewedVersion !== undefined &&
    (lease.kind !== "review" ||
      update.reviewedVersion !== state.evidenceVersion)
  )
    throw new Error("审查只能绑定当前冻结证据版本");
  const { invalidateEvidence, ...changes } = update;
  if (invalidateEvidence && !["prepare", "stop"].includes(lease.kind))
    throw new Error("只有恢复或停止操作可以使生命周期证据失效");
  const next = stateSchema.parse({
    ...state,
    ...changes,
    evidenceVersion:
      state.evidenceVersion + Number(invalidateEvidence === true),
    revision: state.revision + 1,
  });
  await writeJson(statePath(home, id), next);
  if (update.phase === "idle") {
    // 仅显式恢复/停止已取得租约后可解除故障，普通完成不会走到这里。
    await unlink(failurePath(home, id)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  return next;
}
// 开发一旦获准就增加证据版本，即使失败也不能沿用上一次审查结论。
export async function beginSessionOperation(
  home: string,
  id: string,
  lease: SessionOperationLease,
): Promise<void> {
  await assertSessionOperation(home, id, lease);
  const state = await readSessionState(home, id);
  if (state.phase === "busy" && !["prepare", "stop"].includes(lease.kind))
    throw new Error("会话保留未完成操作状态，需要恢复检查");
  if (state.phase === "interrupted" && lease.kind === "development")
    throw new Error("会话已中断，需要先恢复运行环境");
  await writeJson(
    statePath(home, id),
    stateSchema.parse({
      ...state,
      // 补审只读取旧证据，不能把中断现场伪装成已恢复。
      phase: state.phase === "interrupted" ? "interrupted" : "busy",
      evidenceVersion:
        state.evidenceVersion + Number(lease.kind === "development"),
      revision: state.revision + 1,
    }),
  );
}
// 明确中断的状态不会因普通释放自动抹除，等待恢复流程处理。
export async function finishSessionOperation(
  home: string,
  id: string,
  lease: SessionOperationLease,
): Promise<void> {
  await assertSessionOperation(home, id, lease);
  const state = await readSessionState(home, id);
  await writeJson(statePath(home, id), {
    ...state,
    phase: state.phase === "interrupted" ? "interrupted" : "idle",
    revision: state.revision + 1,
  });
}
