import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeExclusiveJson } from "../../src/storage/files.js";

// 多个发布者竞争时只能有一个成功，目标一旦可见就是完整 JSON。
test("原子排他发布只留下一个完整锁，不覆盖赢家且清理临时文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-exclusive-json-"));
  try {
    const lock = join(root, "owner.json");
    const results = await Promise.allSettled([
      writeExclusiveJson(lock, {
        pid: 1,
        identity: "first",
        data: "a".repeat(100000),
      }),
      writeExclusiveJson(lock, {
        pid: 2,
        identity: "second",
        data: "b".repeat(100000),
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "EEXIST" });
    const stored = await readFile(lock, "utf8");
    expect([1, 2]).toContain(JSON.parse(stored).pid);
    await expect(writeExclusiveJson(lock, { pid: 3 })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(lock, "utf8")).toBe(stored);
    expect(await readdir(root)).toEqual(["owner.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
