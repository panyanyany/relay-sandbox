import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// 仅核对本机Linux cgroup v2；远程daemon、v1或权限不足必须报告覆盖缺口。
export async function cgroupMemory(
  pid: number,
  containerId: string,
  read = (path: string) => readFile(path, "utf8"),
) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { coverage: "unavailable", reason: "container_not_running" };
  try {
    const membership = await read(`/proc/${pid}/cgroup`);
    const relative = membership
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (!relative || relative.split("/").includes(".."))
      return { coverage: "unavailable", reason: "cgroup_v2_path_unavailable" };
    // 防止远程daemon的PID碰巧对应本机无关进程，无法匹配时明确不可用。
    if (!relative.includes(containerId))
      return {
        coverage: "unavailable",
        reason: "container_cgroup_identity_unconfirmed",
      };
    const base = "/sys/fs/cgroup";
    const directory = resolve(base, `.${relative}`);
    if (directory !== base && !directory.startsWith(base + sep))
      throw new Error("cgroup路径越界");
    const events = await read(`${directory}/memory.events`);
    const counts: Record<string, number> = {};
    for (const line of events.trim().split("\n")) {
      const [key, value] = line.split(/\s+/);
      if (["oom", "oom_kill", "oom_group_kill", "high", "max"].includes(key!)) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 0)
          throw new Error("cgroup事件计数非法");
        counts[key!] = number;
      }
    }
    let peakBytes: number | null = null;
    try {
      peakBytes = Number((await read(`${directory}/memory.peak`)).trim());
      if (!Number.isSafeInteger(peakBytes) || peakBytes < 0)
        throw new Error("cgroup内存峰值非法");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      coverage: "available",
      counts,
      peakBytes,
      note: "容器生命周期累计值，不能单独归因到本轮",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(code ?? ""))
      return { coverage: "unavailable", reason: code };
    throw error;
  }
}
