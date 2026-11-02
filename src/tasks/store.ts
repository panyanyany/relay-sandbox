import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { validateId } from "../projects/registry.js";
import { readJson, writeJson, appendEvent } from "../storage/files.js";
import type { Task } from "./types.js";
export const taskPath = (home: string, id: string): string => {
  validateId(id);
  return join(home, "tasks", id);
};
export const getTask = (home: string, id: string): Promise<Task> =>
  readJson<Task>(join(taskPath(home, id), "task.json"));
// 状态持久化和事件写入分离，恢复时必须核对运行时实际状态。
export async function saveTask(home: string, task: Task): Promise<void> {
  task.updatedAt = new Date().toISOString();
  await writeJson(join(taskPath(home, task.id), "task.json"), task);
  await appendEvent(join(taskPath(home, task.id), "events.jsonl"), {
    time: task.updatedAt,
    state: task.state,
    round: task.round,
  });
}
export async function listTasks(home: string): Promise<Task[]> {
  await mkdir(join(home, "tasks"), { recursive: true, mode: 0o700 });
  return Promise.all(
    (await readdir(join(home, "tasks")))
      .filter((id) => /^[\w-]+$/.test(id))
      .map((id) => getTask(home, id)),
  );
}
