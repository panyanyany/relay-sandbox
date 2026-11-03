import { cp, rm, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { download, upload } from "../docker/archive.js";
import { execute } from "../docker/execute.js";
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
  if (task.projectMode === "direct") {
    await cp(host, baseline, { recursive: true, verbatimSymlinks: true });
  } else if (reuse) {
    const current = join(root, "environment-current");
    await download(dockerClient(), task.containerId!, current);
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
    // Git管理数据使用本轮宿主副本，不继承上一任务可能修改的hooks/config。
    await rm(join(baseline, ".git"), { recursive: true, force: true });
    try {
      await cp(join(host, ".git"), join(baseline, ".git"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const cleared = await execute(
      dockerClient(),
      task.containerId!,
      [
        "/usr/bin/find",
        "/workspace",
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-exec",
        "/bin/rm",
        "-rf",
        "--",
        "{}",
        "+",
      ],
      {},
      30000,
      4096,
    );
    if (cleared.exitCode !== 0)
      throw new Error("持久环境工作区清理失败，保留现场供排查");
    await upload(dockerClient(), task.containerId!, baseline);
  } else {
    await cp(host, baseline, { recursive: true, verbatimSymlinks: true });
    await upload(dockerClient(), task.containerId!, baseline);
  }
  await writeJson(join(root, "baseline.json"), await scan(baseline));
  // 同步成功才推进基线；临时目录原子更换，失败不假报已同步。
  const next = join(environment, "host-baseline-next");
  await rm(next, { recursive: true, force: true });
  await cp(host, next, { recursive: true, verbatimSymlinks: true });
  await rm(join(environment, "host-baseline"), {
    recursive: true,
    force: true,
  });
  await rename(next, join(environment, "host-baseline"));
}
