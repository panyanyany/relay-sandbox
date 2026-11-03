import { watch, type FSWatcher } from "node:fs";
import { taskPath } from "../tasks/store.js";
import { taskSnapshot } from "../tasks/wait.js";
import { formatError } from "../audit/redaction.js";

export const TASK_EVENT_SUBSCRIPTION_LIMIT = 256;
type State = "initializing" | "active" | "failed";
interface Entry {
  state: State;
  ready: Promise<void>;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  failure?: { stage: "watch" | "send"; time: string };
}
// 每连接独立管理初始化、失效和释放；失败记录也计入上限，防止诊断状态无限增长。
export class TaskSubscriptions {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    private readonly home: string,
    private readonly send: (uri: string) => Promise<void>,
  ) {}

  status(uri: string) {
    const entry = this.entries.get(uri);
    return {
      uri,
      state: entry?.state ?? "absent",
      subscribed: entry?.state === "active",
      failure: entry?.failure ?? null,
      reconnectRequiresResubscribe: true,
    };
  }

  // 错误示范：看到 Map 中有记录便返回成功，会让并发调用绕过尚未完成的校验。
  async subscribe(uri: string, id: string): Promise<void> {
    if (this.closed) throw new Error("事件连接已关闭");
    const previous = this.entries.get(uri);
    if (previous && previous.state !== "failed") return previous.ready;
    if (!previous && this.entries.size >= TASK_EVENT_SUBSCRIPTION_LIMIT)
      throw new Error(
        `当前连接最多订阅${TASK_EVENT_SUBSCRIPTION_LIMIT}个任务（含失效记录）`,
      );
    const entry: Entry = { state: "initializing", ready: Promise.resolve() };
    this.entries.set(uri, entry);
    try {
      // 监听目录而非旧文件 inode，才能接收后台进程的原子替换。
      entry.watcher = watch(taskPath(this.home, id), (_event, filename) => {
        if (
          filename !== null &&
          ![
            "task.json",
            "operation.lock",
            "preparation-cancel.json",
            "resource-pressure.json",
          ].includes(filename.toString())
        )
          return;
        if (
          this.entries.get(uri) !== entry ||
          entry.state !== "active" ||
          entry.timer
        )
          return;
        entry.timer = setTimeout(() => {
          delete entry.timer;
          void this.send(uri).catch((error) =>
            this.fail(uri, entry, "send", error),
          );
        }, 25);
      });
      entry.watcher.on("error", (error) =>
        this.fail(uri, entry, "watch", error),
      );
      entry.ready = this.initialize(uri, id, entry);
    } catch (error) {
      this.remove(uri, entry);
      throw error;
    }
    return entry.ready;
  }

  private async initialize(uri: string, id: string, entry: Entry) {
    try {
      await taskSnapshot(this.home, id);
      if (this.entries.get(uri) !== entry || this.closed)
        throw new Error("订阅初始化期间已取消或连接关闭");
      if (entry.state === "failed")
        throw new Error("订阅监听初始化失败，请查询订阅状态");
      entry.state = "active";
    } catch (error) {
      // 旧初始化不能删除取消后重新建立的新订阅；异步故障状态保留供查询。
      if (entry.state !== "failed") this.remove(uri, entry);
      throw error;
    }
  }

  private dispose(entry: Entry) {
    entry.watcher?.close();
    clearTimeout(entry.timer);
    delete entry.timer;
  }
  private remove(uri: string, entry: Entry) {
    this.dispose(entry);
    if (this.entries.get(uri) === entry) this.entries.delete(uri);
  }
  private fail(
    uri: string,
    entry: Entry,
    stage: "watch" | "send",
    error: unknown,
  ) {
    // 迟到的旧实例故障只记录日志，不使新的订阅失效。
    const current = this.entries.get(uri) === entry;
    if (current) {
      this.dispose(entry);
      entry.state = "failed";
      entry.failure = { stage, time: new Date().toISOString() };
    }
    process.stderr.write(
      JSON.stringify({
        component: "task-events",
        uri,
        stage,
        current,
        error: formatError(error),
      }) + "\n",
    );
  }

  unsubscribe(uri: string) {
    const entry = this.entries.get(uri);
    if (entry) this.remove(uri, entry);
  }
  // 连接关闭后禁止继续注册，尚未完成的初始化也会拒绝。
  close() {
    this.closed = true;
    for (const [uri, entry] of this.entries) this.remove(uri, entry);
  }
}
