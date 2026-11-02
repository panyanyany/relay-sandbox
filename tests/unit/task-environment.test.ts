import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import {
  freezeEnvironment,
  prepareEnvironment,
} from "../../src/tasks/environment.js";
import { readFrozenPolicy } from "../../src/permissions/freeze.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-environment-"));
  roots.push(root);
  const home = join(root, "state"),
    projectRoot = join(root, "project"),
    source = join(root, "source");
  for (const path of [join(home, "permissions"), projectRoot, source])
    await mkdir(path, { recursive: true });
  await writeFile(join(source, "data"), "original");
  const path = join(home, "permissions/project.yaml");
  await writeFile(
    path,
    `resources:\n  - name: cache\n    source: ${source}\n    target: /resources/cache\n    access: read-write\n`,
  );
  return { root, home, projectRoot, source, path };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 组合摘要同时绑定项目检查条件和宿主授权；冻结后不重新取得新权限。
test("冻结授权、空申请选择宿主授权，摘要绑定两侧配置", async () => {
  const { home, path } = await fixture();
  const config = configSchema.parse({});
  const first = await freezeEnvironment(home, "task", "project", config);
  expect(first.policy.resources).toHaveLength(1);
  await writeFile(
    path,
    "network:\n  grants:\n    - target: 0.0.0.0/0\n      ports: all\n",
  );
  expect(await freezeEnvironment(home, "task", "project", config)).toEqual(
    first,
  );
  expect(await readFrozenPolicy(home, "task")).toEqual(first.policy);
  const expanded = await freezeEnvironment(home, "other", "project", config);
  expect(expanded.configDigest).not.toBe(first.configDigest);
  const changed = await freezeEnvironment(
    home,
    "third",
    "project",
    configSchema.parse({ project: { exclude: ["secret"] } }),
  );
  expect(changed.configDigest).not.toBe(expanded.configDigest);
  await expect(
    freezeEnvironment(home, "../task", "project", config),
  ).rejects.toThrow();
  await expect(
    freezeEnvironment(home, "task", "../project", config),
  ).rejects.toThrow();
});
// 后续检查必须复用副本，不能因宿主文件变化覆盖沙箱的本轮资源修改。
test("准备与复用资源且保护控制面，legacy不读取新宿主配置", async () => {
  const { home, source, projectRoot, path } = await fixture();
  const task = { id: "task", projectRoot };
  const { policy } = await freezeEnvironment(
    home,
    task.id,
    "project",
    configSchema.parse({}),
  );
  const first = await prepareEnvironment(home, task, policy, false);
  expect(first.network).toEqual({ mode: "default-open", grants: [] });
  const copied = first.mounts![0]!.Source!;
  await writeFile(join(copied, "data"), "changed");
  await writeFile(path, "broken: [");
  expect(await prepareEnvironment(home, task, policy, true)).toEqual(first);
  expect(await readFile(join(copied, "data"), "utf8")).toBe("changed");
  expect(await readFile(join(source, "data"), "utf8")).toBe("original");
  expect(await prepareEnvironment(home, task, undefined, true)).toEqual({});
  const bad = {
    ...policy,
    resources: policy.resources.map((resource) => ({
      ...resource,
      source: home,
    })),
  };
  await expect(
    prepareEnvironment(home, { ...task, id: "bad" }, bad, false),
  ).rejects.toThrow();
  await expect(
    prepareEnvironment(
      home,
      task,
      JSON.parse(JSON.stringify({ ...policy, schemaVersion: 2 })),
      true,
    ),
  ).rejects.toThrow();
});
