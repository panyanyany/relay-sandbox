import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../storage/files.js";
import { taskPath } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import type { TelemetrySample } from "./status.js";
export interface ResourceWarning {
  containerId: string;
  memoryPercent: number;
  since: string;
  message: string;
}

// 连续有效采样才累积；缺样或进程停止会清除持续计时，不把断线误报为持续压力。
export class MemoryPressure {
  private since = new Map<string, number>();
  private last = 0;
  update(task: Task, sample: TelemetrySample) {
    const now = Date.parse(sample.time);
    if (
      now - this.last >
      task.config.logging.sampleIntervalSeconds * 3000 + 10000
    )
      this.since.clear();
    this.last = now;
    const active = new Set<string>();
    const warnings: ResourceWarning[] = [];
    for (const container of sample.containers) {
      const percent = container.metrics?.memoryPercent;
      if (
        percent === null ||
        percent === undefined ||
        percent < (task.config.logging.memoryWarningPercent ?? 85)
      )
        continue;
      active.add(container.id);
      const since = this.since.get(container.id) ?? now;
      this.since.set(container.id, since);
      if (
        now - since >=
        (task.config.logging.memoryWarningSeconds ?? 30) * 1000
      )
        warnings.push({
          containerId: container.id,
          memoryPercent: Math.round(percent),
          since: new Date(since).toISOString(),
          message:
            "内存持续接近上限，请减少并行浏览器、标签页和构建任务；定期保存阶段结果。",
        });
    }
    for (const id of this.since.keys())
      if (!active.has(id)) this.since.delete(id);
    return warnings;
  }
  reset() {
    this.since.clear();
    this.last = 0;
  }
}
// 写到任务根目录使已有订阅可观察，不并发修改task.json覆盖业务状态。
export async function publishPressure(
  home: string,
  id: string,
  warnings: ResourceWarning[],
) {
  const path = join(taskPath(home, id), "resource-pressure.json");
  let before: ResourceWarning[] = [];
  try {
    before = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // 百分比微小变化不反复通知；进入或退出持续高压时才发布。
  if (
    JSON.stringify(before.map((w) => [w.containerId, w.since])) !==
    JSON.stringify(warnings.map((w) => [w.containerId, w.since]))
  )
    await writeJson(path, warnings);
}
export async function readPressure(
  home: string,
  id: string,
): Promise<ResourceWarning[]> {
  try {
    return JSON.parse(
      await readFile(
        join(taskPath(home, id), "resource-pressure.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
