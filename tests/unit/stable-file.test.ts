import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  hashStable,
  MAX_EXPORT_FILE_BYTES,
} from "../../src/workspace/stable-file.js";
import { snapshot } from "../../src/workspace/snapshot.js";
import { scan } from "../../src/workspace/manifest.js";
import { digest } from "../../src/storage/hash.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-stream-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  return { root, source };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// 多个缓冲区的内容、摘要及权限保持一致，不把流式改动变成文件语义变更。
test("流式扫描和快照保留内容、模式与摘要", async () => {
  const { root, source } = await fixture();
  const content = Buffer.alloc(200000, 97);
  await writeFile(join(source, "file"), content, { mode: 0o751 });
  const sizes: number[] = [];
  expect(
    await hashStable(source, "file", async (chunk) => {
      sizes.push(chunk.length);
    }),
  ).toEqual({ hash: digest(content), size: content.length });
  expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
  const manifest = await snapshot(source, join(root, "copy"), []);
  expect(await readFile(join(root, "copy/file"))).toEqual(content);
  expect(await scan(join(root, "copy"))).toEqual(manifest);
});

// 稀疏超限文件几乎不占磁盘；在读取内容和创建候选目录之前明确拒绝。
test("直接结果采集拒绝超过共享256MiB限制的稀疏文件", async () => {
  const { root, source } = await fixture();
  const file = await open(join(source, "large"), "w");
  try {
    await file.truncate(MAX_EXPORT_FILE_BYTES + 1);
  } finally {
    await file.close();
  }
  await expect(
    snapshot(source, join(root, "copy"), [], MAX_EXPORT_FILE_BYTES),
  ).rejects.toThrow("单文件采集超限");
});

test("限制包含边界值，读取期间增长或变更立即失败", async () => {
  const { source } = await fixture();
  await writeFile(join(source, "file"), "1234");
  expect((await hashStable(source, "file", undefined, 4)).size).toBe(4);
  await expect(hashStable(source, "file", undefined, 3)).rejects.toThrow(
    "超限",
  );
  let changed = false;
  await expect(
    hashStable(
      source,
      "file",
      async () => {
        if (!changed) {
          changed = true;
          await writeFile(join(source, "file"), "longer");
        }
      },
      4,
    ),
  ).rejects.toThrow(/超限|文件变化/);
  await symlink("file", join(source, "link"));
  await expect(hashStable(source, "link")).rejects.toThrow();
});
