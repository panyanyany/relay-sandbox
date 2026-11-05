import { cp, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { download, upload } from "../docker/archive.js";
import {
  replaceGitDirectory,
  replaceRuntimeWorkspace,
  replaceHostBaseline,
} from "../workspace/sync-operations.js";
import { dockerClient } from "../docker/client.js";
import { mergeCandidate } from "../delivery/merge.js";
import { snapshot } from "../workspace/snapshot.js";
import { scan } from "../workspace/manifest.js";
import { writeJson } from "../storage/files.js";
import { taskPath } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { environmentPath } from "./store.js";

// 新宿主快照与旧环境三方同步；保留安装目录，双方冲突时不写入容器或原项目。
export async function synchronizeWorkspace(
  home: string,
  task: Task,
  reuse: boolean,
  delivered = false,
) {
  // 直接挂载已共享原项目；保留创建阶段的审核基线，不维护隔离同步副本。
  // 错误示范：直接模式仍重命名并复制基线，会重复搬运整个项目。
  if (task.projectMode === "direct") return;
  const root = delivered
    ? join(taskPath(home, task.id), "delivery-sync")
    : taskPath(home, task.id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const baseline = join(root, "baseline");
  const environment = environmentPath(home, task.projectId);
  const host = join(root, "host-baseline");
  if (delivered)
    await snapshot(task.projectRoot, host, task.config.project.exclude);
  else await rename(baseline, host);
  if (reuse) {
    const current = join(root, "environment-current");
    await download(
      dockerClient(),
      task.containerId!,
      current,
      task.config.resources,
    );
    await snapshot(current, baseline, []);
    const merged = await mergeCandidate(
      join(environment, "host-baseline"),
      host,
      current,
      baseline,
    );
    if (merged.conflicts.length)
      throw new Error(
        `项目与持久环境同步冲突，请保留现场后处理或显式重置环境: ${merged.conflicts.join(", ")}`,
      );
    await replaceGitDirectory(host, baseline);
    await replaceRuntimeWorkspace(dockerClient(), task.containerId!, baseline);
  } else {
    await cp(host, baseline, { recursive: true, verbatimSymlinks: true });
    await upload(dockerClient(), task.containerId!, baseline);
  }
  await writeJson(join(root, "baseline.json"), await scan(baseline));
  // 同步成功才推进宿主共同基线。
  await replaceHostBaseline(host, join(environment, "host-baseline"));
}
