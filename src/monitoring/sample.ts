import type Docker from "dockerode";
import { dockerClient } from "../docker/client.js";
import type { Task } from "../tasks/types.js";
export interface MetricsInput {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: MetricsInput["cpu_stats"];
  memory_stats: { usage?: number; limit?: number };
  networks?: Docker.NetworkStats;
  pids_stats?: Docker.PidsStats;
  blkio_stats?: Pick<Docker.BlkioStats, "io_service_bytes_recursive">;
}
// CPU 以单核 100% 表示；缺少基线时记录 null，不将缺失数据伪装为零。
export function summarizeStats(stats: MetricsInput, previous?: MetricsInput) {
  const current = stats.cpu_stats,
    before = previous?.cpu_stats ?? stats.precpu_stats;
  const cpuDelta =
    current.cpu_usage.total_usage -
    (before?.cpu_usage?.total_usage ?? current.cpu_usage.total_usage);
  const systemDelta =
    (current.system_cpu_usage ?? 0) - (before?.system_cpu_usage ?? 0);
  const cpus = current.online_cpus ?? current.cpu_usage.percpu_usage?.length;
  const memory = stats.memory_stats;
  const networks = Object.values(stats.networks ?? {});
  const io = stats.blkio_stats?.io_service_bytes_recursive ?? [];
  return {
    cpuPercent:
      systemDelta > 0 && cpuDelta >= 0 && cpus
        ? (cpuDelta / systemDelta) * cpus * 100
        : null,
    memoryUsageBytes: memory.usage ?? null,
    memoryLimitBytes: memory.limit ?? null,
    memoryPercent:
      memory.limit && memory.limit > 0 && memory.usage !== undefined
        ? (memory.usage / memory.limit) * 100
        : null,
    pids: stats.pids_stats?.current ?? null,
    networkRxBytes: stats.networks
      ? networks.reduce((sum, entry) => sum + entry.rx_bytes, 0)
      : null,
    networkTxBytes: stats.networks
      ? networks.reduce((sum, entry) => sum + entry.tx_bytes, 0)
      : null,
    blockReadBytes: stats.blkio_stats
      ? io
          .filter((entry) => entry.op.toLowerCase() === "read")
          .reduce((sum, entry) => sum + entry.value, 0)
      : null,
    blockWriteBytes: stats.blkio_stats
      ? io
          .filter((entry) => entry.op.toLowerCase() === "write")
          .reduce((sum, entry) => sum + entry.value, 0)
      : null,
  };
}
// 从宿主按任务标签采样全部开发/检查/服务容器，不读取容器文件或环境凭据。
export async function sampleTask(
  task: Task,
  previous: Map<string, Docker.ContainerStats>,
  signal?: AbortSignal,
) {
  const docker = dockerClient(10000);
  const listed = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`relay-sandbox.task=${task.id}`] }),
  });
  const ids = new Set(listed.map((c) => c.Id));
  if (task.containerId) ids.add(task.containerId);
  const containers = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    const container = docker.getContainer(id);
    try {
      const info = await container.inspect();
      let metrics = null;
      signal?.throwIfAborted();
      if (info.State.Running) {
        const stats = await container.stats({
          stream: false,
          "one-shot": true,
        });
        metrics = summarizeStats(stats, previous.get(id));
        previous.set(id, stats);
      }
      containers.push({
        id,
        name: info.Name,
        state: info.State.Status,
        running: info.State.Running,
        exitCode: info.State.ExitCode,
        oomKilled: info.State.OOMKilled,
        restartCount: info.RestartCount,
        metrics,
      });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      containers.push({ id, state: "removed", metrics: null });
    }
  }
  for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);
  return {
    schemaVersion: 1,
    time: new Date().toISOString(),
    taskId: task.id,
    taskState: task.state,
    round: task.round,
    containers,
  };
}
