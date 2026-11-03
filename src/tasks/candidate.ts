import type Docker from "dockerode";
import { readFrozenPolicy } from "../permissions/freeze.js";
import { stopEnvironment } from "./environment-lifecycle.js";
import { prepareCheckResources } from "./check-resources.js";
import { installEnvironment } from "./environment-install.js";
import { type EnvironmentState } from "./environment-state.js";
import type { RuntimeHandle } from "../docker/runtime.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scan, manifestDigest } from "../workspace/manifest.js";
import { profileSchema } from "../config/schema.js";
import { readJson, writeJson } from "../storage/files.js";
import { withFinalizer } from "../storage/finalize.js";
import { makePlan } from "../delivery/apply.js";
import { runChecks } from "../delivery/checks.js";
import { isReady } from "../delivery/policy.js";
import { createRuntime, removeRuntime } from "../docker/runtime.js";
import { upload } from "../docker/archive.js";
import { dockerClient } from "../docker/client.js";
import { getTask, saveTask, taskPath } from "./store.js";
import { withTaskLock } from "./lock.js";
import type { Task } from "./types.js";
import { taskProjectMode } from "../workspace/access.js";
import type { Manifest } from "../workspace/manifest.js";
// 各收尾独立尝试，保留代理证据；一个失败不能跳过其他运行资源的回收。
async function finishCheck(
  home: string,
  taskId: string,
  docker: Docker,
  runtime: RuntimeHandle,
  environment?: EnvironmentState,
) {
  const failures: unknown[] = [];
  if (environment) {
    try {
      await stopEnvironment(docker, home, taskId, environment);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await removeRuntime(docker, runtime);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "检查环境收尾不完整");
}
// 宿主解决冲突后复用同一检查入口，不重新生成候选而覆盖宿主修复。
export async function verifyCandidate(home: string, task: Task) {
  const root = taskPath(home, task.id),
    candidate = join(root, "candidate");
  const manifest = await scan(candidate),
    artifact = manifestDigest(manifest);
  const direct = (await taskProjectMode(home, task)) === "direct";
  if (direct && manifestDigest(await scan(task.projectRoot)) !== artifact)
    throw new Error(
      "直接模式的候选与原项目不同，请在原项目修改后重新收集和检查",
    );
  if (artifact !== task.artifactDigest) {
    delete task.review;
    task.checks = [];
  }
  task.artifactDigest = artifact;
  await writeJson(
    join(root, "apply-plan.json"),
    makePlan(
      task.id,
      artifact,
      task.configDigest,
      direct
        ? await readJson<Manifest>(join(root, "baseline.json"))
        : await scan(join(root, "current")),
      manifest,
    ),
  );
  task.checks = [];
  if (task.config.delivery.checks.length) {
    const profile = profileSchema.parse(
      await readJson(join(root, "profile.json")),
    );
    // 新建检查容器，避免开发 Agent 遗留进程干预测试；绝不修改正常返工的工作区。
    const policy = await readFrozenPolicy(home, task.id);
    const options = await prepareCheckResources(home, task, policy);
    const runtimeId = `${task.id}-check-${randomUUID().slice(0, 8)}`;
    const docker = dockerClient(),
      runtime = await createRuntime(
        docker,
        runtimeId,
        profile.image,
        profile.networkImage,
        task.config,
        task.id,
        options,
      );
    let environment: EnvironmentState | undefined;
    await withFinalizer(
      async () => {
        await upload(docker, runtime.containerId, candidate);
        if (policy)
          environment = await installEnvironment(docker, {
            home,
            taskId: task.id,
            runtimeId,
            containerId: runtime.containerId,
            policy,
            role: "check",
          });
        task.checks = await runChecks(docker, {
          ...task,
          containerId: runtime.containerId,
        });
      },
      () => finishCheck(home, task.id, docker, runtime, environment),
    );
  }
  task.deliveryPrepared = true;
  task.state = isReady(task) ? "ready" : "checking";
  if (
    task.checks.some(
      (check) => check.status === "failed" || check.status === "error",
    )
  )
    task.state = "blocked";
  await saveTask(home, task);
  return { task, conflicts: [] as string[] };
}
export async function acceptCandidate(home: string, id: string) {
  return withTaskLock(home, id, async () => {
    const task = await getTask(home, id);
    if (
      !["queued", "awaiting_user", "checking", "blocked", "ready"].includes(
        task.state,
      )
    )
      throw new Error("任务当前不能确认候选");
    return verifyCandidate(home, task);
  });
}
