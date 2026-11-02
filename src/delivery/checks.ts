import type Docker from "dockerode";
import { execute } from "../docker/execute.js";
import type { Task, CheckResult } from "../tasks/types.js";
// 检查器返回事实，是否重试或返工由任务层决定。
export async function runChecks(
  docker: Docker,
  task: Task,
): Promise<CheckResult[]> {
  if (!task.containerId || !task.artifactDigest)
    throw new Error("任务缺少运行环境或产物");
  const results: CheckResult[] = [];
  for (const check of task.config.delivery.checks) {
    try {
      const execution = await execute(
        docker,
        task.containerId,
        check.argv,
        {},
        task.config.lifecycle.taskTimeoutMinutes * 60000,
        task.config.resources.maxOutputBytes,
      );
      results.push({
        name: check.name,
        status: execution.exitCode === 0 ? "passed" : "failed",
        artifactDigest: task.artifactDigest,
        exitCode: execution.exitCode,
        output: execution.output,
      });
    } catch (error) {
      results.push({
        name: check.name,
        status: "error",
        artifactDigest: task.artifactDigest,
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return results;
}
