import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { profileSchema, type Config } from "../../config/schema.js";
import { dockerClient } from "../../docker/client.js";
import { createRuntime } from "../../docker/runtime.js";
import { upload } from "../../docker/archive.js";
import { readJson } from "../../storage/files.js";
import { withFinalizer } from "../../storage/finalize.js";
import { scan, manifestDigest } from "../../workspace/manifest.js";
import { readFrozenPolicy } from "../../permissions/freeze.js";
import { runChecks } from "../../delivery/checks.js";
import { getTask, taskPath } from "../../tasks/store.js";
import { prepareCheckResources } from "../../tasks/check-resources.js";
import { installEnvironment } from "../../tasks/environment-install.js";
import type { EnvironmentState } from "../../tasks/environment-state.js";
import { finishCheck } from "../../tasks/check-runtime.js";
import type { ReviewEvidence } from "./evidence.js";
// 只执行固定证据副本，不借用冻结中的开发容器，也不加载任何 Agent 凭据。
export async function runSessionReviewChecks(
  home: string,
  evidence: ReviewEvidence,
  checks: Config["delivery"]["checks"],
  docker = dockerClient(),
) {
  const task = await getTask(home, evidence.taskId);
  if (
    task.terminalSessionId !== evidence.sessionId ||
    task.configDigest !== evidence.configDigest ||
    JSON.stringify(task.config.delivery.checks) !== JSON.stringify(checks)
  )
    throw new Error("审查检查的任务归属或冻结配置不一致");
  if (manifestDigest(await scan(evidence.codePath)) !== evidence.codeDigest)
    throw new Error("审查检查代码摘要不一致");
  const profile = profileSchema.parse(
    await readJson(join(taskPath(home, task.id), "profile.json")),
  );
  const policy = await readFrozenPolicy(home, task.id);
  const options = await prepareCheckResources(home, task, policy, {
    requirePaused: true,
  });
  const runtimeId = `${task.id}-review-${randomUUID().slice(0, 8)}`;
  const runtime = await createRuntime(
    docker,
    runtimeId,
    profile.image,
    profile.networkImage,
    task.config,
    task.id,
    options,
  );
  let environment: EnvironmentState | undefined;
  return withFinalizer(
    async () => {
      await upload(docker, runtime.containerId, evidence.codePath);
      if (policy)
        environment = await installEnvironment(docker, {
          home,
          taskId: task.id,
          runtimeId,
          containerId: runtime.containerId,
          policy,
          role: "check",
        });
      const results = await runChecks(docker, {
        ...task,
        containerId: runtime.containerId,
        artifactDigest: evidence.codeDigest,
      });
      const direct =
        policy?.resources
          .filter(
            (resource) =>
              resource.mode === "direct" && resource.access === "read-write",
          )
          .map((resource) => resource.name) ?? [];
      const boundary = direct.length
        ? `检查边界：显式授权的直接可写资源仍共享，检查可能修改这些资源：${direct.join("、")}。\n`
        : "";
      return results.map((result) => ({
        ...result,
        output: boundary + result.output,
      }));
    },
    () => finishCheck(home, task.id, docker, runtime, environment),
  );
}
