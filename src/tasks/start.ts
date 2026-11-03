import { reserveTask } from "./create.js";
import { dispatchOperation } from "./dispatch.js";
import { formatError } from "../audit/redaction.js";
import { taskSnapshot } from "./wait.js";

// MCP只等待配置冻结和进程派发；项目复制、容器启动与审计安装均在后台执行。
export async function startTask(home: string, project: string, prompt: string) {
  const task = await reserveTask(home, project, prompt);
  let worker;
  try {
    worker = await dispatchOperation(home, task.id, "initialize-task");
  } catch (error) {
    // 预约已存在时保留可查询的ID及错误链；预约前的错误继续由调用方处理。
    return {
      id: task.id,
      taskId: task.id,
      workerPid: undefined,
      status: "failed",
      stage: "dispatch",
      error: formatError(error),
      nextAction: "get_result_then_cleanup_and_report",
    };
  }
  // 观察失败不能误报为派发失败，更不能丢掉已经返回的后台进程身份。
  try {
    return { ...(await taskSnapshot(home, task.id)), id: task.id, ...worker };
  } catch (error) {
    return {
      id: task.id,
      ...worker,
      stage: "observation",
      error: formatError(error),
      nextAction: "get_task",
    };
  }
}
