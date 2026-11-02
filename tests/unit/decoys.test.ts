import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDecoyManifest,
  publicDecoySummary,
} from "../../src/decoys/manifest.js";
import { planPlacement } from "../../src/decoys/placement.js";

const roots: string[] = [];
// 每次测试使用独立宿主目录，避免接触真实凭据。
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-decoys-"));
  roots.push(root);
  return join(root, "private-manifest.json");
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("兼容优先诱饵", () => {
  it("关闭时零投放且不创建私密文件", async () => {
    const path = await fixture();
    const manifest = await ensureDecoyManifest(path, "task-1", {
      enabled: false,
      clients: [],
    });
    expect(planPlacement(manifest).files).toEqual([]);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("同任务幂等、跨任务不同，只生成明确无效值且公开摘要无值", async () => {
    const path = await fixture();
    const policy = { enabled: true, clients: [] };
    const first = await ensureDecoyManifest(path, "task-1", policy);
    expect(await ensureDecoyManifest(path, "task-1", policy)).toEqual(first);
    const other = await ensureDecoyManifest(await fixture(), "task-2", policy);
    expect(other.entries[0]!.value).not.toBe(first.entries[0]!.value);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const publicText = JSON.stringify(publicDecoySummary(first));
    for (const entry of first.entries) {
      expect(entry.value).toMatch(/^RELAY_SANDBOX_FAKE_/);
      expect(publicText).not.toContain(entry.value);
      expect(entry.path).toMatch(
        /^\/home\/node\/\.config\/relay-sandbox\/decoys\//,
      );
    }
    expect(planPlacement(first).files).toHaveLength(2);
    expect(await readFile(path, "utf8")).toContain(first.entries[0]!.value);
    await expect(ensureDecoyManifest(path, "other", policy)).rejects.toThrow(
      "任务",
    );
  });
  it("已有文件、父目录链接和资源用途冲突均跳过；不覆盖默认凭据", async () => {
    const manifest = await ensureDecoyManifest(await fixture(), "task", {
      enabled: true,
      clients: [],
    });
    const aws = manifest.entries[0]!;
    expect(
      planPlacement(manifest, { existingPaths: [aws.path] }).summary[0],
    ).toMatchObject({ status: "skipped", reason: "existing-path" });
    expect(
      planPlacement(manifest, { symlinkPaths: ["/home/node/.config"] }).files,
    ).toEqual([]);
    expect(
      planPlacement(manifest, {
        conflictingPaths: ["/home/node/.config/relay-sandbox"],
      }).files,
    ).toEqual([]);
    const plan = planPlacement(manifest, {
      existingPaths: ["/home/node/.aws/credentials"],
    });
    expect(plan.files).toHaveLength(2);
    expect(JSON.stringify(plan)).not.toContain("AWS_ACCESS_KEY_ID");
    expect(plan.files.every((file) => file.mode === 0o600)).toBe(true);
  });
  it("损坏清单明确失败，不重新生成或接受非隔离路径", async () => {
    const path = await fixture();
    const manifest = await ensureDecoyManifest(path, "task", {
      enabled: true,
      clients: [],
    });
    manifest.entries[0]!.path = "/home/node/.aws/credentials";
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      ensureDecoyManifest(path, "task", { enabled: true, clients: [] }),
    ).rejects.toThrow();
  });
});
