import { requireWorkspaceUsable } from "../../src/tasks/readiness.js";
import { resumeTask } from "../../src/tasks/recovery.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { saveTask, taskPath } from "../../src/tasks/store.js";
import { withTaskLock } from "../../src/tasks/lock.js";
import { cleanupTask, stopTask } from "../../src/tasks/cleanup.js";
import { collectTask, runTask } from "../../src/tasks/run.js";
import { recollectTask } from "../../src/tasks/recollect.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { verifyCandidate } from "../../src/tasks/candidate.js";
import { applyTask } from "../../src/tasks/deliver.js";
import { canRecollect, environmentReady } from "../../src/tasks/readiness.js";
import { taskNextAction } from "../../src/tasks/guidance.js";
import type { Task } from "../../src/tasks/types.js";

vi.mock("../../src/docker/client.js", () => ({ dockerClient: () => ({}) }));
const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-recovery-boundary-"));
  homes.push(home);
  const task: Task = {
    id: "task",
    projectId: "project",
    projectRoot: "/unused",
    containerId: "container",
    prompt: "fixture",
    config: configSchema.parse({}),
    configDigest: "fixture",
    state: "failed",
    createdAt: "",
    updatedAt: "",
    round: 1,
    warnings: [],
    checks: [],
    environmentReady: true,
  };
  await saveTask(home, task);
  return { home, task };
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

// 在真实操作锁内模拟恢复导出/上传阶段；拒绝取消清理且现场保持完整。
test.each(["recoveryPending", "workspaceOperation", "before-marker"])(
  "%s阶段取消和清理不能绕过恢复锁",
  async (phase) => {
    const { home, task } = await fixture();
    if (phase === "recoveryPending") task.recoveryPending = true;
    if (phase === "workspaceOperation") task.workspaceOperation = true;
    await saveTask(home, task);
    const evidence = join(
      taskPath(home, task.id),
      "resume-sync",
      "fixture",
      "before",
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "code"), "retained");
    await withTaskLock(home, task.id, async () => {
      await expect(stopTask(home, task.id)).rejects.toThrow("当前操作尚未完成");
      await expect(cleanupTask(home, task.id)).rejects.toThrow(
        "当前操作尚未完成",
      );
    });
    expect(await readFile(join(evidence, "code"), "utf8")).toBe("retained");
  },
);

test("半写入工作区不能经重收集、候选或应用入口绕过保护", async () => {
  const { home, task } = await fixture();
  task.workspaceSync = { id: "sync", status: "applying" };
  task.failureStage = "collection";
  task.artifactDigest = "old";
  task.resultGeneration = "old";
  task.candidateGeneration = "old";
  await saveTask(home, task);
  expect(canRecollect(task)).toBe(false);
  expect(environmentReady(task)).toBe(false);
  expect(taskNextAction(task)).not.toBe("collect_artifacts");
  for (const operation of [
    () => runTask(home, task.id),
    () => recollectTask(home, task.id),
    () => collectTask(home, task),
    () => prepareDelivery(home, task.id),
    () => verifyCandidate(home, task),
    () => applyTask(home, task.id),
  ])
    await expect(operation()).rejects.toThrow(/同步未完成|尚未准备就绪/);
});

test("恢复交接和同步期间的可见指引是等待", async () => {
  const { task } = await fixture();
  task.state = "preparing";
  task.recoveryPending = true;
  expect(taskNextAction(task)).toBe("wait_task");
  expect(environmentReady(task)).toBe(false);
  task.state = "failed";
  delete task.recoveryPending;
  task.workspaceOperation = true;
  expect(taskNextAction(task)).toBe("wait_task");
});

// 背景进程必须匹配同一次派发，不能在取消后复活或抢占下一次恢复。
test.each(["stopped", "queued"] as const)(
  "迟到恢复不能启动%s状态的新派发",
  async (state) => {
    const { home, task } = await fixture();
    task.state = state;
    task.networkId = "network";
    task.recoveryPending = true;
    task.recoveryDispatch = "new-dispatch";
    await saveTask(home, task);
    await expect(resumeTask(home, task.id, "old-dispatch")).rejects.toThrow(
      "任务不可恢复",
    );
  },
);

test("旧成功检查点须恢复迁移，不能直接交付", async () => {
  const { task } = await fixture();
  task.workspaceSync = { id: "old", status: "applied" };
  expect(() => requireWorkspaceUsable(task)).toThrow("旧恢复检查点");
  expect(taskNextAction(task)).toBe("resume_task");
  task.state = "prepared";
  expect(taskNextAction(task)).toBe("cancel_task_then_resume_task");
});
