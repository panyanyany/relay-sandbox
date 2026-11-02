import type { Task } from "./types.js";
// 同名 checking 状态区分“开发已收集”和“最终候选已检查”，避免宿主无限等待。
export function taskNextAction(task: Task): string {
  if (["queued", "running", "collecting", "applying"].includes(task.state))
    return "wait_task";
  if (task.state === "preparing") return "run_task";
  if (task.state === "checking")
    return task.deliveryPrepared
      ? "read_artifact_then_review_task"
      : "prepare_delivery";
  if (task.state === "ready") return "apply_task";
  if (task.state === "awaiting_user") return "report_task_then_wait_for_user";
  if (task.state === "cleaned") return "report_task";
  return "get_result_then_cleanup_and_report";
}
