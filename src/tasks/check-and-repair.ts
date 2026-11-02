import { getTask, saveTask } from "./store.js";
import { prepareDelivery } from "./prepare.js";
import { runTask } from "./run.js";
// 确定性的检查失败交给开发 Agent 修复；总次数持久化，重复调用不会重置上限。
export async function checkAndRepair(home: string, id: string) {
  let prepared = await prepareDelivery(home, id);
  while (prepared.task.state === "blocked") {
    const task = await getTask(home, id);
    const failed = task.checks.filter((check) => check.status === "failed");
    // 运行环境错误不能靠反复修改代码解决，保留错误并立即暂停。
    if (task.checks.some((check) => check.status === "error") || !failed.length)
      break;
    if ((task.repairRounds ?? 0) >= task.config.delivery.maxRepairRounds) break;
    task.repairRounds = (task.repairRounds ?? 0) + 1;
    await saveTask(home, task);
    await runTask(
      home,
      id,
      `修复以下检查失败，保留项目其他修改，然后结束本轮。\n${failed.map((check) => `${check.name}:\n${check.output}`).join("\n")}`,
    );
    prepared = await prepareDelivery(home, id);
  }
  return prepared;
}
