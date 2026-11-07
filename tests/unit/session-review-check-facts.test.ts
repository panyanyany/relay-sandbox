import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixedCheckFacts } from "../../src/sessions/review/check-facts.js";
// 模型超时后补审复用已完成检查，不能拿当前容器资源重新计算旧证据。
test("检查事实绑定固定材料与规则，离线补审无需再次执行检查", async () => {
  const root = await mkdtemp(join(tmpdir(), "check-facts-"));
  try {
    const evidence = {
      root,
      id: "evidence",
      codeDigest: "code",
      configDigest: "config",
    };
    const checks = [{ name: "test", argv: ["npm", "test"] }];
    const run = vi.fn(async () => [
      { status: "passed", artifactDigest: "code" },
    ]);
    const first = await fixedCheckFacts(evidence, checks, run);
    expect(await fixedCheckFacts(evidence, checks)).toEqual(first);
    expect(run).toHaveBeenCalledOnce();
    await expect(
      fixedCheckFacts({ ...evidence, codeDigest: "changed" }, checks),
    ).rejects.toThrow("绑定");
    await expect(
      fixedCheckFacts(evidence, [{ name: "other", argv: ["true"] }]),
    ).rejects.toThrow("绑定");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("没有固定检查结果也没有隔离执行器时明确未完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "check-facts-"));
  try {
    await expect(
      fixedCheckFacts(
        { root, id: "e", codeDigest: "c", configDigest: "f" },
        [],
      ),
    ).rejects.toThrow("隔离检查");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
