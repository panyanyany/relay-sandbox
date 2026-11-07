import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import { appendEvent } from "../storage/files.js";
import { redact } from "./redaction.js";
import type { AuditEvent, AuditReport } from "./report.js";

export interface AuditSession {
  finish(): Promise<AuditReport>;
  snapshot?(): Promise<AuditReport>;
}
const gaps = [
  "覆盖 open/openat、unlink/unlinkat、rename 系列；不覆盖所有系统调用、继承文件描述符及 mmap",
  "相对路径缺少工作目录解析，可能漏掉敏感目标；不观测进程内存中的 getenv",
];
// 按路径名称识别内层敏感目标；只保留路径元数据，不读取文件内容。
export function sensitivePath(path: string): boolean {
  return (
    /(^|\/)(\.ssh|\.aws|\.config|\.codex|\.claude|\.opencode|\.env[^/]*|\.bashrc|\.bash_profile|\.profile|\.npmrc|\.pypirc|\.gitconfig|credentials|[^/]*[._-](?:key|token|secret))($|\/)/i.test(
      path,
    ) ||
    (path.startsWith("/proc/") && /\/(environ|mem)$/.test(path))
  );
}
// 过滤器固定为容器 cgroup，开发 Agent 无法修改宿主采集规则。
function program(cgroup: string): string {
  return `BEGIN { printf("ready\\n"); }
tracepoint:syscalls:sys_enter_open,tracepoint:syscalls:sys_enter_openat /cgroup == cgroupid("${cgroup}")/ {
 @target[tid] = str(args.filename); @action[tid] = 1; @flags[tid] = args.flags;
}
tracepoint:syscalls:sys_enter_unlink,tracepoint:syscalls:sys_enter_unlinkat /cgroup == cgroupid("${cgroup}")/ {
 @target[tid] = str(args.pathname); @action[tid] = 2;
}
tracepoint:syscalls:sys_enter_rename,tracepoint:syscalls:sys_enter_renameat,tracepoint:syscalls:sys_enter_renameat2 /cgroup == cgroupid("${cgroup}")/ {
 @target[tid] = str(args.newname); @origin[tid] = str(args.oldname); @action[tid] = 3;
}
tracepoint:syscalls:sys_exit_open,tracepoint:syscalls:sys_exit_openat,tracepoint:syscalls:sys_exit_unlink,tracepoint:syscalls:sys_exit_unlinkat,tracepoint:syscalls:sys_exit_rename,tracepoint:syscalls:sys_exit_renameat,tracepoint:syscalls:sys_exit_renameat2
/@action[tid]/ {
 printf("event %d %d %d %s\\n", @action[tid], args.ret, @flags[tid], @target[tid]);
 if(@origin[tid]!=""){printf("event %d %d %d %s\\n", @action[tid], args.ret, @flags[tid], @origin[tid]);}
 delete(@target[tid]); delete(@action[tid]); delete(@flags[tid]);delete(@origin[tid]);
}
END { clear(@target); clear(@action); clear(@flags); clear(@origin); }`;
}
// 不可用时产生明确警告，不把审计故障变成开发或交付失败。
export async function startAudit(
  docker: Docker,
  containerId: string,
  taskId: string,
  evidence: string,
  secrets: string[] = [],
): Promise<AuditSession> {
  const events: AuditEvent[] = [];
  const failures: string[] = [];
  // 同类异常去重并限制错误数，避免异常文件名放大宿主内存使用。
  const recordFailure = (message: string) => {
    if (!failures.includes(message) && failures.length < 100)
      failures.push(message);
  };
  let processHandle: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let writes = Promise.resolve();
  let exited = false;
  let stopping = false;
  // 快照等待已接收事件落盘，但保持采集器运行。
  async function snapshot(
    coverage: AuditReport["coverage"],
  ): Promise<AuditReport> {
    await writes;
    if (exited && !stopping)
      recordFailure("采集器已异常退出，后续行为存在覆盖缺口");
    return {
      coverage,
      gaps: [...gaps, ...failures],
      events: structuredClone(events),
      warnings: events
        .map((event) => `${event.target}: ${event.action} ${event.result}`)
        .concat("审计覆盖不完整，请阅读 gaps"),
    };
  }
  try {
    const info = await docker.getContainer(containerId).inspect();
    const membership = await readFile(`/proc/${info.State.Pid}/cgroup`, "utf8");
    const group = membership
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (!group || !/^\/[\w./-]+$/.test(group))
      throw new Error("需要可解析的 cgroup v2");
    const child = spawn(
      "sudo",
      [
        "-n",
        "bpftrace",
        "-q",
        "-f",
        "json",
        "-e",
        program(join("/sys/fs/cgroup", group)),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    processHandle = child;
    closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        exited = true;
        resolve(code);
      });
    });
    let buffer = "",
      stderr = "",
      readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4096);
    });
    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 65536) {
        recordFailure("采集帧超限");
        buffer = "";
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as { type: string; data: string };
          if (item.type !== "printf") {
            recordFailure("采集器报告非事件帧或丢失");
            continue;
          }
          if (item.data === "ready\n") {
            readyResolve?.();
            continue;
          }
          const match = /^event ([123]) (-?\d+) (\d+) ([^\r\n]*)\n$/.exec(
            item.data,
          );
          if (!match) {
            recordFailure("无法解析事件，可能包含控制字符");
            continue;
          }
          const target = match[4]!;
          if (!sensitivePath(target)) continue;
          const event: AuditEvent = {
            time: new Date().toISOString(),
            taskId,
            target: redact(target, secrets),
            action:
              match[1] === "1"
                ? Number(match[3]) & 1603
                  ? "open-write"
                  : "open-read"
                : match[1] === "2"
                  ? "unlink"
                  : "rename",
            result: Number(match[2]) < 0 ? "blocked" : "success",
            source: "host-bpftrace/cgroup-v2",
          };
          // 日志设有数量上限；达到上限记录缺口，保持持续排空内核输出。
          if (events.length >= 10000) {
            if (!failures.includes("事件上限")) recordFailure("事件上限");
            continue;
          }
          events.push(event);
          writes = writes
            .then(() => appendEvent(evidence, event))
            .catch((error) => {
              recordFailure(`证据保存失败: ${String(error)}`);
            });
        } catch {
          recordFailure("采集帧格式无效");
        }
      }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        closed.then((code) => {
          throw new Error(`采集器退出 ${code}: ${stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("采集器启动超时")), 10000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    recordFailure(
      redact(error instanceof Error ? error.message : String(error)),
    );
    if (processHandle) processHandle.kill("SIGINT");
    if (closed)
      await closed.catch((error) => {
        recordFailure(String(error));
      });
    return {
      snapshot: () => snapshot("unavailable"),
      finish: () => snapshot("unavailable"),
    };
  }

  return {
    snapshot: () => snapshot("partial"),
    finish: async () => {
      stopping = true;
      processHandle!.kill("SIGINT");
      const code = await closed!;
      if (code !== 0) recordFailure(`采集器退出码 ${code}`);
      return snapshot("partial");
    },
  };
}
