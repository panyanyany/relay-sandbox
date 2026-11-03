import { expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));
import { readFile } from "node:fs/promises";
import { processIdentity } from "../../src/tasks/lock.js";

// 错误示范：把进程退出竞态当成未知故障，会中断正常的后台收尾查询。
test("进程已退出返回空身份，真实读取错误继续抛出", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error(code), { code }),
    );
    expect(await processIdentity(123)).toBeUndefined();
  }
  const denied = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(processIdentity(123)).rejects.toBe(denied);
});
