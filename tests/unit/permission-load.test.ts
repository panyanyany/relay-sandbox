import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { loadHostPermissions } from "../../src/permissions/load.js";
import {
  freezePolicy,
  policyDigest,
  readFrozenPolicy,
} from "../../src/permissions/freeze.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";

const homes: string[] = [];
// 每例创建独立宿主状态目录，不读取用户真实授权。
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "relay-permissions-"));
  homes.push(path);
  await mkdir(join(path, "permissions"));
  return path;
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("宿主缺配置默认无授权，项目请求只能选择宿主已授权资源", async () => {
  const root = await home();
  expect((await loadHostPermissions(root, "project")).resources).toEqual([]);
  await writeFile(
    join(root, "permissions/project.yaml"),
    "resources:\n  - name: cache\n    source: /srv/cache\n    target: /resources/cache\n",
  );
  expect((await loadHostPermissions(root, "project")).resources).toHaveLength(
    1,
  );
  expect((await loadHostPermissions(root, "project", [])).resources).toEqual(
    [],
  );
  expect(
    (await loadHostPermissions(root, "project", ["cache"])).resources[0]
      ?.source,
  ).toBe("/srv/cache");
  await expect(
    loadHostPermissions(root, "project", ["secrets"]),
  ).rejects.toThrow("未授权");
  await expect(loadHostPermissions(root, "../project")).rejects.toThrow("标识");
});

test("坏格式、未知字段和文件读取错误不可静默变成默认值", async () => {
  const root = await home(),
    path = join(root, "permissions/project.yaml");
  for (const content of ["network: [", "privileged: true", "null"]) {
    await writeFile(path, content);
    await expect(loadHostPermissions(root, "project")).rejects.toThrow();
  }
  await rm(path);
  await mkdir(path);
  await expect(loadHostPermissions(root, "project")).rejects.toThrow();
});

test("冻结快照不可扩权覆盖，恢复不受最新宿主配置影响", async () => {
  const root = await home();
  const original = hostPermissionsSchema.parse({});
  expect(await readFrozenPolicy(root, "task")).toBeUndefined();
  const frozen = await freezePolicy(root, "task", original);
  expect(frozen.schemaVersion).toBe(1);
  expect(await freezePolicy(root, "task", original)).toEqual(frozen);
  await writeFile(
    join(root, "permissions/project.yaml"),
    "network:\n  grants:\n    - target: 0.0.0.0/0\n      ports: all\n",
  );
  const expanded = await loadHostPermissions(root, "project");
  await expect(freezePolicy(root, "task", expanded)).rejects.toThrow("冻结");
  expect(await readFrozenPolicy(root, "task")).toEqual(frozen);
  expect(policyDigest(frozen)).toMatch(/^[a-f0-9]{64}$/);
  expect(
    policyDigest({ ...frozen, decoys: { ...frozen.decoys, enabled: true } }),
  ).not.toBe(policyDigest(frozen));
});

test("并发冻结不会覆盖已发布快照，损坏快照必须报错", async () => {
  const root = await home(),
    empty = hostPermissionsSchema.parse({});
  const alternate = hostPermissionsSchema.parse({ decoys: { enabled: true } });
  const results = await Promise.allSettled([
    freezePolicy(root, "task", empty),
    freezePolicy(root, "task", alternate),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const saved = JSON.parse(
    await readFile(join(root, "tasks/task/policy.json"), "utf8"),
  );
  expect(await readFrozenPolicy(root, "task")).toEqual(saved);
  for (const invalid of [
    "{",
    JSON.stringify({ ...saved, schemaVersion: 99 }),
    JSON.stringify({ ...saved, privileged: true }),
  ]) {
    await writeFile(join(root, "tasks/task/policy.json"), invalid);
    await expect(readFrozenPolicy(root, "task")).rejects.toThrow();
  }
});

// 按实际UTF-8序列化容量验证；超限不得先落盘再让报告降级。
test("冻结快照容量边界统一，已有超限快照仍可恢复读取", async () => {
  const { POLICY_MAX_BYTES, serializePolicy } =
    await import("../../src/permissions/contract.js");
  const root = await home();
  const policy = hostPermissionsSchema.parse({
    resources: [{ name: "large", source: "/x", target: "/r" }],
  });
  const base = { ...policy, schemaVersion: 1 as const };
  const padding = POLICY_MAX_BYTES - Buffer.byteLength(serializePolicy(base));
  base.resources[0]!.source += "x".repeat(padding);
  expect(Buffer.byteLength(serializePolicy(base))).toBe(POLICY_MAX_BYTES);
  await freezePolicy(root, "boundary", policy);
  const { buildPolicySummary } =
    await import("../../src/reporting/policy-summary.js");
  expect(await buildPolicySummary(root, "boundary")).toHaveProperty(
    "mode",
    "frozen",
  );
  base.resources[0]!.source += "x";
  await expect(freezePolicy(root, "oversize", policy)).rejects.toThrow("64KiB");
  await expect(
    readFile(join(root, "tasks/oversize/policy.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  // 已有旧快照不静默裁剪、不套默认授权；报告独立声明超限。
  await mkdir(join(root, "tasks/legacy-large"), { recursive: true });
  await writeFile(
    join(root, "tasks/legacy-large/policy.json"),
    JSON.stringify(base, null, 2) + "\n",
  );
  expect((await readFrozenPolicy(root, "legacy-large"))?.resources).toEqual(
    base.resources,
  );

  expect(await buildPolicySummary(root, "legacy-large")).toHaveProperty(
    "traffic.gaps",
    expect.arrayContaining(["policy-record-oversized"]),
  );
});

// 新默认只在宿主配置加载时补齐，既有冻结策略和显式隔离不变。
test("新任务默认直接挂载，显式隔离与旧快照保持原语义", async () => {
  const root = await home();
  const initial = await loadHostPermissions(root, "project");
  expect(initial.project?.mode).toBe("direct");
  const frozen = await freezePolicy(root, "new-task", initial);
  expect(frozen.project?.mode).toBe("direct");
  await writeFile(
    join(root, "permissions/project.yaml"),
    "network: {grants: []}\n",
  );
  expect((await loadHostPermissions(root, "project")).project?.mode).toBe(
    "direct",
  );
  await writeFile(
    join(root, "permissions/project.yaml"),
    "project: {mode: isolated}\n",
  );
  expect((await loadHostPermissions(root, "project")).project?.mode).toBe(
    "isolated",
  );
  expect((await readFrozenPolicy(root, "new-task"))?.project?.mode).toBe(
    "direct",
  );
});
