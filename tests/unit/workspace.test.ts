import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { snapshot } from "../../src/workspace/snapshot.js";
import { scan } from "../../src/workspace/manifest.js";
import { changes } from "../../src/workspace/diff.js";
import { mergeCandidate } from "../../src/delivery/merge.js";
import { applyChanges, makePlan } from "../../src/delivery/apply.js";
const roots: string[] = [];
// 每项测试独立创建并清理项目，避免使用真实用户文件。
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-unit-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("完整副本包含忽略文件，显式排除并保留外部链接本身", async () => {
  const root = await fixture(),
    source = join(root, "source"),
    target = join(root, "target");
  await mkdir(source);
  await writeFile(join(source, ".gitignore"), "ignored\n");
  await writeFile(join(source, "ignored"), "dirty");
  await writeFile(join(source, "secret"), "excluded");
  await symlink("/outside/secret", join(source, "link"));
  const baseline = await snapshot(source, target, ["secret"]);
  expect(baseline.map((e) => e.path)).toEqual([
    ".gitignore",
    "ignored",
    "link",
  ]);
  expect(await scan(target)).toEqual(baseline);
  expect(changes(baseline, await scan(target))).toEqual([]);
  await chmod(join(target, "ignored"), 0o755);
  expect(changes(baseline, await scan(target))).toHaveLength(1);
});
test("拒绝项目内任务目录和 worktree 外部管理引用", async () => {
  const root = await fixture();
  await expect(snapshot(root, join(root, "nested"), [])).rejects.toThrow(
    "不能位于",
  );
  await writeFile(join(root, ".git"), "gitdir: /outside");
  await expect(snapshot(root, root + "-copy", [])).rejects.toThrow("worktree");
});
test("三方合并保留宿主修改，备份后应用", async () => {
  const root = await fixture();
  const base = join(root, "base"),
    result = join(root, "result"),
    current = join(root, "current"),
    candidate = join(root, "candidate");
  await mkdir(base);
  await writeFile(join(base, "code"), "one\ntwo\nthree\nfour\nfive\n");
  await snapshot(base, result, []);
  await snapshot(base, current, []);
  await writeFile(join(result, "code"), "ONE\ntwo\nthree\nfour\nfive\n");
  await writeFile(join(current, "code"), "one\ntwo\nthree\nfour\nFIVE\n");
  await snapshot(current, candidate, []);
  expect(
    (await mergeCandidate(base, result, current, candidate)).conflicts,
  ).toEqual([]);
  const plan = makePlan(
    "t",
    "artifact",
    "config",
    await scan(current),
    await scan(candidate),
  );
  await applyChanges(current, candidate, join(root, "backup"), plan);
  expect(await readFile(join(current, "code"), "utf8")).toBe(
    "ONE\ntwo\nthree\nfour\nFIVE\n",
  );
  expect(await readFile(join(root, "backup/files/code"), "utf8")).toContain(
    "FIVE",
  );
});
test("应用拒绝摘要过期及符号链接父目录", async () => {
  const root = await fixture(),
    source = join(root, "source"),
    current = join(root, "current");
  await mkdir(source);
  await mkdir(current);
  await writeFile(join(current, "file"), "old");
  const before = await scan(current);
  await writeFile(join(source, "file"), "new");
  const plan = makePlan("t", "a", "c", before, await scan(source));
  await writeFile(join(current, "file"), "user-change");
  await expect(
    applyChanges(current, source, join(root, "backup"), plan),
  ).rejects.toThrow("目标已变化");
  await mkdir(join(source, "dir"));
  await writeFile(join(source, "dir/file"), "attack");
  await symlink(source, join(current, "dir"));
  const malicious = makePlan(
    "t",
    "a",
    "c",
    [],
    (await scan(source)).filter((e) => e.path === "dir/file"),
  );
  await expect(
    applyChanges(current, source, join(root, "backup2"), malicious),
  ).rejects.toThrow("应用失败");
  expect(await readFile(join(source, "file"), "utf8")).toBe("new");
});
test("候选合并拒绝经宿主链接写出目录", async () => {
  const root = await fixture(),
    base = join(root, "base"),
    result = join(root, "result"),
    current = join(root, "current"),
    candidate = join(root, "candidate");
  for (const dir of [base, result, current, candidate]) await mkdir(dir);
  await mkdir(join(result, "dir"));
  await writeFile(join(result, "dir/file"), "new");
  await symlink("/tmp", join(current, "dir"));
  await symlink("/tmp", join(candidate, "dir"));
  await expect(
    mergeCandidate(base, result, current, candidate),
  ).rejects.toThrow("父路径");
});

// 空目录也参与摘要、差异及应用，不能在交付时静默丢失。
test("空目录新增、删除和文件目录类型替换", async () => {
  const root = await fixture(),
    base = join(root, "base"),
    result = join(root, "result"),
    candidate = join(root, "candidate");
  await mkdir(base);
  await mkdir(join(base, "old"));
  await writeFile(join(base, "replace"), "old-file");
  await snapshot(base, result, []);
  await snapshot(base, candidate, []);
  await rm(join(result, "old"), { recursive: true });
  await rm(join(result, "replace"));
  await mkdir(join(result, "replace"));
  await writeFile(join(result, "replace/child"), "child");
  await mkdir(join(result, "empty"));
  expect(
    (await mergeCandidate(base, result, base, candidate)).conflicts,
  ).toEqual([]);
  await applyChanges(
    base,
    candidate,
    join(root, "backup"),
    makePlan("t", "a", "c", await scan(base), await scan(candidate)),
  );
  expect(await scan(base)).toEqual(await scan(candidate));
  expect(
    (await scan(base)).some(
      (entry) => entry.path === "empty" && entry.type === "directory",
    ),
  ).toBe(true);
});

// 前一文件已应用、后一文件发生并发修改时立即停止，保留真实恢复证据。
test("部分应用失败保留已应用记录和用户后续修改", async () => {
  const root = await fixture(),
    current = join(root, "current"),
    source = join(root, "source");
  await mkdir(current);
  await mkdir(source);
  for (const path of ["a", "b"]) {
    await writeFile(join(current, path), "old");
    await writeFile(join(source, path), "new");
  }
  const plan = makePlan("t", "a", "c", await scan(current), await scan(source));
  await writeFile(join(current, "b"), "user-later");
  await expect(
    applyChanges(current, source, join(root, "backup"), plan),
  ).rejects.toThrow("目标已变化");
  expect(await readFile(join(current, "a"), "utf8")).toBe("new");
  expect(await readFile(join(current, "b"), "utf8")).toBe("user-later");
  const journal = await readFile(join(root, "backup/applied.jsonl"), "utf8");
  expect(journal).toContain("prepared");
  expect(journal).toContain("applied");
  expect(await readFile(join(root, "backup/files/a"), "utf8")).toBe("old");
});
