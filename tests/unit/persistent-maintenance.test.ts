import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import type { Task } from "../../src/tasks/types.js";
import {
  saveEnvironment,
  environmentPath,
} from "../../src/environments/store.js";
import { prepareEnvironment } from "../../src/tasks/environment.js";
import { prepareCheckResources } from "../../src/tasks/check-resources.js";
import { preparePersistentAudit } from "../../src/environments/audit.js";
import { loadMainEnvironment } from "../../src/tasks/environment-state.js";
import { taskPath } from "../../src/tasks/store.js";
import { ensureDecoyManifest } from "../../src/decoys/manifest.js";
import * as restart from "../../src/tasks/restart.js";
import * as workspace from "../../src/environments/workspace.js";
import * as cleanup from "../../src/tasks/cleanup.js";
import { readEnvironment } from "../../src/environments/store.js";
import { installEnvironment } from "../../src/tasks/environment-install.js";
import { dockerClient } from "../../src/docker/client.js";
import { idleEnvironment } from "../../src/environments/idle.js";
import { writeJson } from "../../src/storage/files.js";

const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getContainer: () => ({ inspect }) }),
}));
const roots: string[] = [];
// 使用真实私有目录与资源校验，只替换 Docker 状态及故障点。
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-maintenance-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(project);
  const task: Task = {
    id: "task",
    projectId: "project",
    projectRoot: project,
    environmentId: "env",
    containerId: "container",
    networkId: "network",
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    round: 0,
    checks: [],
    warnings: [],
  };
  await saveEnvironment(home, {
    version: 1,
    id: "env",
    projectId: "project",
    signature: "test",
    mode: "persistent",
    idleRetentionHours: 24,
    activeTaskId: task.id,
    containerId: task.containerId!,
    networkId: task.networkId!,
    createdAt: task.createdAt,
  });
  inspect.mockResolvedValue({ State: { Running: false } });
  return { root, home, task };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("检查冻结持久副本而非宿主新副本，测试写入不污染环境，下次检查重新冻结", async () => {
  const { root, home, task } = await fixture();
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "data"), "host");
  const policy = {
    schemaVersion: 1 as const,
    ...hostPermissionsSchema.parse({
      resources: [
        {
          name: "cache",
          source,
          target: "/resources/cache",
          mode: "copy",
          access: "read-write",
        },
      ],
    }),
  };
  await prepareEnvironment(home, task, policy, false);
  const resources = join(environmentPath(home, task.projectId), "resources");
  await prepareEnvironment(home, task, policy, false, resources);
  await writeFile(join(resources, "cache/data"), "developed");
  const options = await prepareCheckResources(home, task, policy);
  const copy = options.mounts![0]!.Source!;
  expect(await readFile(join(copy, "data"), "utf8")).toBe("developed");
  await writeFile(join(copy, "data"), "check mutation");
  expect(await readFile(join(resources, "cache/data"), "utf8")).toBe(
    "developed",
  );
  expect(await readFile(join(source, "data"), "utf8")).toBe("host");
  await prepareCheckResources(home, task, policy);
  expect(await readFile(join(copy, "data"), "utf8")).toBe("developed");
  inspect.mockResolvedValue({ State: { Running: true } });
  await expect(prepareCheckResources(home, task, policy)).rejects.toThrow(
    "必须停止",
  );
});

test.each(["decoys.json", "audit-summary.json"])(
  "持久审计文件 %s 损坏时保存缺口且不重建清单",
  async (name) => {
    const { home, task } = await fixture();
    const root = environmentPath(home, task.projectId);
    const policy = {
      schemaVersion: 1 as const,
      ...hostPermissionsSchema.parse({ decoys: { enabled: true } }),
    };
    if (name === "audit-summary.json")
      await ensureDecoyManifest(
        join(root, "decoys.json"),
        task.environmentId!,
        policy.decoys,
      );
    await writeFile(join(root, name), "broken", { mode: 0o600 });
    expect(await preparePersistentAudit(home, task, policy)).toBe(false);
    expect(await readFile(join(root, name), "utf8")).toBe("broken");
    const state = await loadMainEnvironment(home, task.id);
    expect(state?.summary.traffic).toBe("unavailable");
    expect(state?.summary.gaps).toContain("persistent-audit-unavailable");
    expect(task.warnings.join()).toContain("历史诱饵匹配不可用");
    const diagnostic = await readFile(
      join(
        taskPath(home, task.id),
        "traffic",
        task.id,
        "diagnostics/persistent-audit-unavailable.json",
      ),
      "utf8",
    );
    expect(diagnostic).toContain("error");
    const resumed = await installEnvironment(dockerClient(), {
      home,
      taskId: task.id,
      runtimeId: task.id,
      containerId: task.containerId!,
      policy,
    });
    expect(resumed.summary.gaps).toContain("persistent-audit-unavailable");
    expect(resumed.summary.traffic).toBe("unavailable");
  },
);

test("同步与停止同时失败保留两个原因，环境仍标记需要重置", async () => {
  const { home, task } = await fixture();
  const image = `sha256:${"a".repeat(64)}`;
  await writeJson(join(taskPath(home, task.id), "profile.json"), {
    endpoint: "http://localhost:1234",
    model: "test",
    apiKeyEnv: "TEST_KEY",
    protocol: "responses",
    image,
    networkImage: image,
  });
  vi.spyOn(restart, "restartTaskRuntime").mockResolvedValue(undefined);
  vi.spyOn(workspace, "synchronizeWorkspace").mockRejectedValue(
    new Error("sync failure"),
  );
  vi.spyOn(cleanup, "stopTaskResources").mockRejectedValue(
    new Error("stop failure"),
  );
  const error = await idleEnvironment(home, task).catch((error) => error);
  expect((await readEnvironment(home, task.projectId))?.needsReset).toBe(true);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((item: Error) => item.message)).toEqual([
    "sync failure",
    "stop failure",
  ]);
});
