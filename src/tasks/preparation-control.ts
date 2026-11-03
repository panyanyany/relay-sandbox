import { access } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../storage/files.js";
import { taskPath } from "./store.js";

export class PreparationCancelled extends Error {
  constructor() {
    super("用户已取消环境准备");
    this.name = "PreparationCancelled";
  }
}
// 独立文件避免准备进程保存旧任务快照时覆盖取消请求。
export async function preparationCancelled(home: string, id: string) {
  try {
    await access(join(taskPath(home, id), "preparation-cancel.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function requestPreparationCancellation(home: string, id: string) {
  await writeJson(join(taskPath(home, id), "preparation-cancel.json"), {
    requestedAt: new Date().toISOString(),
  });
}
// AbortSignal传递到文件扫描与分块复制；外部请求依赖准备范围内的有界超时。
export async function preparationControl(home: string, id: string) {
  const controller = new AbortController();
  let pending = Promise.resolve();
  const check = async () => {
    if (await preparationCancelled(home, id))
      controller.abort(new PreparationCancelled());
    controller.signal.throwIfAborted();
  };
  await check();
  const timer = setInterval(() => {
    pending = pending.then(check).catch((error) => {
      controller.abort(error);
    });
  }, 100);
  return {
    signal: controller.signal,
    check,
    close: async () => {
      clearInterval(timer);
      await pending;
    },
  };
}
