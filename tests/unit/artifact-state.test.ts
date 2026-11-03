import { taskResult } from "../../src/tasks/result.js";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, getTask } from "../../src/tasks/store.js";
import { discardCandidate } from "../../src/tasks/artifact-state.js";
import { acceptCandidate } from "../../src/tasks/candidate.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { scan, manifestDigest } from "../../src/workspace/manifest.js";
import { writeJson } from "../../src/storage/files.js";
import type { Task } from "../../src/tasks/types.js";

// 走真实候选入口：新结果不能确认旧候选，但重新准备及人工修正仍然可用。
test("收集代次隔离旧候选，重新准备后允许人工解决冲突", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-artifact-state-"));
  const root = join(home, "tasks/task");
  const project = join(home, "project");
  const task: Task = {
    id: "task",
    projectId: "p",
    projectRoot: project,
    prompt: "x",
    config: configSchema.parse({ delivery: { aiReview: false, checks: [] } }),
    configDigest: "config",
    state: "checking",
    round: 2,
    containerId: "unused",
    createdAt: "",
    updatedAt: "",
    checks: [],
    warnings: [],
    resultGeneration: "new",
    candidateGeneration: "old",
    deliveryPrepared: false,
  };
  try {
    for (const dir of [
      project,
      join(root, "candidate"),
      join(root, "current"),
      join(root, "baseline"),
      join(root, "result"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(root, "candidate/old.txt"), "old");
    await writeFile(join(root, "apply-plan.json"), "{}");
    await writeFile(join(project, "report.txt"), "host");
    await writeFile(join(root, "baseline/report.txt"), "base");
    await writeFile(join(root, "result/report.txt"), "result");
    task.artifactDigest = manifestDigest(await scan(join(root, "result")));
    await writeJson(
      join(root, "baseline.json"),
      await scan(join(root, "baseline")),
    );
    await saveTask(home, task);
    expect((await taskResult(home, task.id)).applicationPlan).toBeNull();
    await expect(acceptCandidate(home, task.id)).rejects.toThrow(
      "当前收集结果",
    );
    await discardCandidate(home, task);
    await expect(access(join(root, "candidate"))).rejects.toThrow();
    await expect(access(join(root, "apply-plan.json"))).rejects.toThrow();
    await saveTask(home, task);
    const prepared = await prepareDelivery(home, task.id);
    expect(prepared.task.state).toBe("awaiting_user");
    await writeFile(join(root, "candidate/report.txt"), "resolved");
    expect((await acceptCandidate(home, task.id)).task.state).toBe("ready");
    expect((await getTask(home, task.id)).candidateGeneration).toBe("new");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
