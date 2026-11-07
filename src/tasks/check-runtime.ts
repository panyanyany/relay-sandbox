import type Docker from "dockerode";
import type { RuntimeHandle } from "../docker/runtime.js";
import { removeRuntime } from "../docker/runtime.js";
import { stopEnvironment } from "./environment-lifecycle.js";
import type { EnvironmentState } from "./environment-state.js";
// 收尾独立尝试，单项失败不能跳过其他检查资源回收。
export async function finishCheck(
  home: string,
  taskId: string,
  docker: Docker,
  runtime: RuntimeHandle,
  environment?: EnvironmentState,
) {
  const failures: unknown[] = [];
  if (environment)
    try {
      await stopEnvironment(docker, home, taskId, environment);
    } catch (error) {
      failures.push(error);
    }
  try {
    await removeRuntime(docker, runtime);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "检查环境收尾不完整");
}
