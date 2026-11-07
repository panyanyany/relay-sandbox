import type { StartupContext } from "./startup-context.js";

// 只关闭当前入口显式登记的句柄，不按PID或容器名称猜测清理范围。
export async function closeStartup(startup: StartupContext) {
  const failures: unknown[] = [];
  for (const resource of startup.resources()) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "启动资源清理失败");
}
