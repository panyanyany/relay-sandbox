import type { Config } from "../config/schema.js";
import type { ReviewDecision } from "../agents/host/contract.js";
export type TaskState =
  | "queued"
  | "preparing"
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
  review?: ReviewDecision;
  deliveryPrepared?: boolean;
  applicationStatus?: "not_attempted" | "in_progress" | "applied" | "failed";
  checks: CheckResult[];
  warnings: string[];
  error?: string;
}
