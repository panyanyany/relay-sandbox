import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { prepareEnvironment } from "../../src/tasks/environment.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { scan, manifestDigest } from "../../src/workspace/manifest.js";
import { writeJson } from "../../src/storage/files.js";
import type { Task } from "../../src/tasks/types.js";
import { runSessionReviewChecks } from "../../src/sessions/review/checks.js";
import { prepareCheckResources } from "../../src/tasks/check-resources.js";
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  task: vi.fn(),
  policy: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  checks: vi.fn(),
  install: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getContainer: () => ({ inspect: mocks.inspect }) }),
}));
vi.mock("../../src/tasks/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tasks/store.js")>()),
  getTask: mocks.task,
}));
vi.mock("../../src/permissions/freeze.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/permissions/freeze.js")>()),
  readFrozenPolicy: mocks.policy,
}));
vi.mock("../../src/docker/runtime.js", () => ({
  createRuntime: mocks.create,
  removeRuntime: mocks.remove,
}));
vi.mock("../../src/docker/archive.js", () => ({ upload: mocks.upload }));
vi.mock("../../src/delivery/checks.js", () => ({ runChecks: mocks.checks }));
vi.mock("../../src/tasks/environment-install.js", () => ({
  installEnvironment: mocks.install,
}));
vi.mock("../../src/tasks/environment-lifecycle.js", () => ({
  stopEnvironment: mocks.stop,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "review-check-"));
  roots.push(home);
  const codePath = join(home, "code");
  await mkdir(codePath);
  await writeFile(join(codePath, "index.js"), "test");
  const id = randomUUID(),
    sessionId = randomUUID(),
    config = configSchema.parse({
      delivery: { checks: [{ name: "unit", argv: ["node", "index.js"] }] },
    });
  const task: Task = {
    id,
    projectId: "test",
    projectRoot: join(home, "project"),
    terminalSessionId: sessionId,
    containerId: "development",
    config,
    configDigest: "frozen",
    state: "prepared",
    prompt: "test",
    round: 0,
    checks: [],
    warnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const evidence = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    sessionId,
    taskId: id,
    evidenceVersion: 0,
    configDigest: "frozen",
    codeDigest: manifestDigest(await scan(codePath)),
    logDigest: "logs",
    createdAt: new Date().toISOString(),
    root: home,
    codePath,
    behaviorPath: join(home, "behavior.json"),
    gaps: [],
  };
  await writeJson(
    join(home, "tasks", id, "profile.json"),
    profileSchema.parse({
      endpoint: "https://example.test",
      model: "test",
      apiKeyEnv: "KEY",
      protocol: "responses",
      image: `image@sha256:${"a".repeat(64)}`,
      networkImage: `network@sha256:${"b".repeat(64)}`,
    }),
  );
  mocks.task.mockResolvedValue(task);
  mocks.inspect.mockResolvedValue({ State: { Running: true, Paused: true } });
  mocks.policy.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({
    containerId: "isolated-check",
    networkId: "check-network",
  });
  mocks.checks.mockImplementation(async (_docker, checked) => [
    {
      name: "unit",
      status: "failed",
      artifactDigest: checked.artifactDigest,
      exitCode: 1,
      output: "assertion failed",
    },
  ]);
  return { home, task, evidence, checks: config.delivery.checks };
}
test("检查只上传固定代码副本，失败事实绑定digest并清理独立运行时", async () => {
  const f = await fixture();
  const result = await runSessionReviewChecks(f.home, f.evidence, f.checks);
  expect(mocks.upload).toHaveBeenCalledWith(
    expect.anything(),
    "isolated-check",
    f.evidence.codePath,
  );
  expect(result).toMatchObject([
    { status: "failed", artifactDigest: f.evidence.codeDigest },
  ]);
  expect(mocks.checks.mock.calls[0]?.[1]).toMatchObject({
    containerId: "isolated-check",
  });
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
test("paused 与 stopped严格区分，代码变化拒绝且不启动检查", async () => {
  const f = await fixture();
  mocks.inspect.mockResolvedValue({ State: { Running: false, Paused: false } });
  await expect(
    prepareCheckResources(f.home, f.task, undefined, { requirePaused: true }),
  ).rejects.toThrow(/暂停/);
  await writeFile(join(f.evidence.codePath, "index.js"), "changed");
  await expect(
    runSessionReviewChecks(f.home, f.evidence, f.checks),
  ).rejects.toThrow(/摘要/);
  expect(mocks.create).not.toHaveBeenCalled();
});
test("上传失败仍清理，检查配置漂移明确失败", async () => {
  const f = await fixture();
  mocks.upload.mockRejectedValueOnce(new Error("upload failed"));
  await expect(
    runSessionReviewChecks(f.home, f.evidence, f.checks),
  ).rejects.toThrow(/upload failed/);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
  await expect(runSessionReviewChecks(f.home, f.evidence, [])).rejects.toThrow(
    /配置/,
  );
});

// 保持显式 direct 授权；copy 资源重新冻结为检查副本，不污染开发资源。
test("资源副本独立且直接可写资源边界进入检查事实，代理独立收尾", async () => {
  const f = await fixture();
  await mkdir(f.task.projectRoot);
  const source = await mkdtemp(join(tmpdir(), "review-resource-"));
  roots.push(source);
  const policy = {
    schemaVersion: 1 as const,
    ...hostPermissionsSchema.parse({
      resources: [
        {
          name: "copy",
          source,
          target: "/resources/copy",
          mode: "copy",
          access: "read-write",
        },
      ],
    }),
  };
  await writeFile(join(source, "file"), "frozen resource");
  await prepareEnvironment(f.home, f.task, policy, false);
  const direct = await mkdtemp(join(tmpdir(), "review-direct-"));
  roots.push(direct);
  policy.resources.push({
    name: "direct",
    source: direct,
    target: "/resources/direct",
    mode: "direct",
    access: "read-write",
  });
  mocks.policy.mockResolvedValue(policy);
  mocks.install.mockResolvedValue({
    summary: {
      runtimeId: "check",
      containerId: "isolated-check",
      role: "check",
      schemaVersion: 1,
      enabled: false,
      traffic: "disabled",
      placements: [],
      gaps: [],
    },
  });
  const result = await runSessionReviewChecks(f.home, f.evidence, f.checks);
  const mounts = mocks.create.mock.calls[0]?.[6].mounts;
  expect(mounts).toEqual(
    expect.arrayContaining([expect.objectContaining({ Source: direct })]),
  );
  expect(
    mounts.find(
      (mount: { Target: string }) => mount.Target === "/resources/copy",
    ).Source,
  ).toContain("check-resources");
  expect(result[0]?.output).toContain("显式授权的直接可写资源");
  expect(result[0]?.output).toContain("assertion failed");
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
