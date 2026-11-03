import type { Config } from "../config/schema.js";
import type { ReviewDecision } from "../agents/host/contract.js";
export type TaskState =
  | "queued"
  | "preparing"
  | "prepared"
  | "running"
  | "collecting"
  | "checking"
  | "ready"
  | "blocked"
  | "awaiting_user"
  | "applying"
  | "completed"
  | "stopped"
  | "interrupted"
  | "cleaned"
  | "failed";
export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "error" | "skipped";
  artifactDigest: string;
  exitCode: number | null;
  output: string;
}
export interface Task {
  id: string;
  projectId: string;
  projectRoot: string;
  // 宿主冻结模式的诊断副本；旧任务省略时仍按隔离处理。
  projectMode?: "isolated" | "direct";
  projectIdentity?: string;
  // 稳定环境独立于任务；省略时保留旧版按任务回收的语义。
  environmentId?: string;
  // 显式准备完成标记；旧任务省略时根据容器存在性兼容。
  environmentReady?: boolean;
  prompt: string;
  config: Config;
  configDigest: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  round: number;
  repairRounds?: number;
  interruptedAt?: string;
  expiresAt?: string;
  cleanedAt?: string;
  reportsPurgedAt?: string;
  containerId?: string;
  networkId?: string;
  artifactDigest?: string;
  // 每次收集产生新代次，候选准备后绑定；返工与重收集不能沿用旧候选。
  resultGeneration?: string;
  candidateGeneration?: string;
  // 恢复检查点分别定位宿主快照和有效交付基线；初始快照留作证据。
  workspaceSync?: {
    id: string;
    status: "applying" | "applied";
    deliveryBase?: string;
    version?: 2;
  };
  // 后台恢复交接和运行时同步期间，取消/清理必须取得同一任务锁。
  recoveryPending?: boolean;
  recoveryDispatch?: string;
  workspaceOperation?: boolean;
  review?: ReviewDecision;
  deliveryPrepared?: boolean;
  applicationStatus?: "not_attempted" | "in_progress" | "applied" | "failed";
  checks: CheckResult[];
  warnings: string[];
  failureStage?: "execution" | "collection";
  error?: string;
}
