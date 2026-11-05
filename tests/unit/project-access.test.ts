import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  link,
  stat,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { synchronizeWorkspace } from "../../src/environments/workspace.js";
import { taskPath, getTask } from "../../src/tasks/store.js";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { freezePolicy, policyDigest } from "../../src/permissions/freeze.js";
import { digest } from "../../src/storage/hash.js";
import {
  projectMode,
  projectMounts,
  taskProjectMode,
} from "../../src/workspace/access.js";
import { buildUserReport } from "../../src/reporting/user-report.js";
import { saveTask } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-project-access-"));
  roots.push(root);
  const home = join(root, "state"),
    project = join(root, "project");
  await mkdir(home);
  await mkdir(project);
  await writeFile(join(project, "code"), "original");
  return { root, home, project };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// 旧快照不补字段，避免升级后审核摘要失效；项目副本不能授权挂载原项目。
test("旧任务保持隔离且冻结摘要不变，模式只接受宿主配置", async () => {
  const { home } = await fixture();
  const legacy = {
    version: 1,
    network: { grants: [] },
    resources: [],
    decoys: { enabled: false, clients: [] },
    schemaVersion: 1,
  } as const;
  const frozen = await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({}),
  );
  expect(projectMode(frozen)).toBe("isolated");
  expect(projectMode(undefined)).toBe("isolated");
  expect(policyDigest(frozen)).toBe(digest(JSON.stringify(legacy)));
  expect(() => configSchema.parse({ project: { mode: "direct" } })).toThrow();
  expect(() =>
    hostPermissionsSchema.parse({ project: { mode: "unknown" } }),
  ).toThrow();
  expect(() =>
    hostPermissionsSchema.parse({ project: { mode: "direct", source: "/" } }),
  ).toThrow();
});

// 冻结后不能靠修改宿主文件给已有隔离任务扩权。
test("直接模式冻结且诊断副本不一致时失败", async () => {
  const { home } = await fixture();
  await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({ project: { mode: "direct" } }),
  );
  const task: Pick<Task, "id" | "projectMode"> = {
    id: "task",
    projectMode: "direct",
  };
  expect(await taskProjectMode(home, task)).toBe("direct");
  await expect(
    taskProjectMode(home, { ...task, projectMode: "isolated" }),
  ).rejects.toThrow("不一致");
  await expect(
    freezePolicy(home, "task", hostPermissionsSchema.parse({})),
  ).rejects.toThrow("冻结");
  await rm(join(home, "tasks/task/policy.json"));
  await expect(taskProjectMode(home, task)).rejects.toThrow("不一致");
});

// 不能用排除规则制造虚假的文件隔离，也不为默认模式生成宿主挂载。
test("直接模式映射固定工作区，排除冲突和控制面重叠明确拒绝", async () => {
  const { home, project } = await fixture();
  const policy = await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({ project: { mode: "direct" } }),
  );
  const config = configSchema.parse({});
  expect(await projectMounts(home, project, config, policy)).toEqual([
    {
      Type: "bind",
      Source: project,
      Target: "/workspace",
      ReadOnly: false,
      BindOptions: { Propagation: "rprivate" },
    },
  ]);
  await expect(
    projectMounts(
      home,
      project,
      configSchema.parse({ project: { exclude: [".env"] } }),
      policy,
    ),
  ).rejects.toThrow("project.exclude");
  await expect(projectMounts(home, home, config, policy)).rejects.toThrow(
    "控制目录",
  );
  expect(
    await projectMounts(home, project, config, {
      ...policy,
      project: undefined,
    }),
  ).toEqual([]);
});

// 项目内常见工具链接无需跟随读取；硬链接可能让写入影响项目外真实文件。
test("直接项目不跟随链接，拒绝外部硬链接", async () => {
  const { root, home, project } = await fixture();
  const policy = await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({ project: { mode: "direct" } }),
  );
  await symlink("/etc/passwd", join(project, "escape"));
  expect(
    await projectMounts(home, project, configSchema.parse({}), policy),
  ).toHaveLength(1);
  await rm(join(project, "escape"));
  await link(join(project, "code"), join(root, "hard-link"));
  await expect(
    projectMounts(home, project, configSchema.parse({}), policy),
  ).rejects.toThrow("硬链接");
});

// 审核拒绝不等于原项目未变；即便清理后仍要明确事后检查语义。
test("直接模式被拒绝时报告原项目影响未知，不承诺阻止或回滚", async () => {
  const { home, project } = await fixture();
  await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({ project: { mode: "direct" } }),
  );
  await saveTask(home, {
    id: "task",
    projectId: "project",
    projectRoot: project,
    projectMode: "direct",
    prompt: "fixture",
    config: configSchema.parse({}),
    configDigest: "c",
    artifactDigest: "a",
    state: "cleaned",
    applicationStatus: "not_attempted",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
    review: {
      schemaVersion: 1,
      taskId: "task",
      configDigest: "c",
      artifactDigest: "a",
      verdict: "reject",
      summary: "危险代码",
      findings: [],
    },
  });
  const report = await buildUserReport(home, "task");
  expect(report.originalProjectChangedByTask).toBeNull();
  expect(report.deliveryKind).toBe("post_write_check");
  expect(report.userMessage).toContain("事后检查未通过");
  expect(report.userMessage).toContain("不会撤销");
  expect(report.userMessage).not.toContain("原项目：未由本任务应用修改");
});

// 保留初始审核证据；直接模式不建立任何隔离同步副本或触发容器传输。
test("直接模式同步保留基线身份与内容，不生成共同基线", async () => {
  const { home, project } = await fixture();
  const task: Task = {
    id: "direct-sync",
    projectId: "project",
    projectRoot: project,
    projectMode: "direct",
    prompt: "fixture",
    config: configSchema.parse({}),
    configDigest: "c",
    state: "prepared",
    createdAt: "",
    updatedAt: "",
    round: 0,
    checks: [],
    warnings: [],
  };
  await saveTask(home, task);
  const root = taskPath(home, task.id),
    baseline = join(root, "baseline");
  await mkdir(baseline);
  await writeFile(join(baseline, "code"), "immutable evidence");
  const before = await stat(baseline);
  for (const reuse of [false, true])
    await synchronizeWorkspace(home, task, reuse);
  await synchronizeWorkspace(home, task, true, true);
  expect((await stat(baseline)).ino).toBe(before.ino);
  expect(await readFile(join(baseline, "code"), "utf8")).toBe(
    "immutable evidence",
  );
  expect(await readdir(root)).toEqual(
    expect.arrayContaining(["baseline", "task.json"]),
  );
  for (const path of [
    join(root, "host-baseline"),
    join(root, "delivery-sync"),
    join(home, "environments", "project", "host-baseline"),
  ])
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await getTask(home, task.id)).state).toBe("prepared");
});
