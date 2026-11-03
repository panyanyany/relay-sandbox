import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import type Docker from "dockerode";
import { expect, test } from "vitest";
import type { ExportLimits } from "../../src/docker/export-budget.js";
import { download } from "../../src/docker/archive.js";

type HeaderArgument = {
  name: string;
  type?: "file" | "link" | "symlink";
  mode?: number;
  linkname?: string;
};

// 合成真实tar流走公开导出入口，覆盖Docker可能返回的前向引用硬链接。
async function exported(
  entries: (HeaderArgument & { body?: string })[],
  check: (root: string) => Promise<void>,
  limits: ExportLimits = {},
) {
  const root = await mkdtemp(join(tmpdir(), "relay-archive-"));
  const archive = pack();
  for (const { body, ...header } of entries) archive.entry(header, body ?? "");
  archive.finalize();
  const docker = {
    getContainer: () => ({ getArchive: async () => archive }),
  } as unknown as Docker;
  try {
    await download(docker, "fixture", join(root, "result"), limits);
    await check(join(root, "result"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("硬链接前向引用与链转换为独立普通文件", async () => {
  await exported(
    [
      { name: "workspace/first", type: "link", linkname: "workspace/second" },
      { name: "workspace/second", type: "link", linkname: "workspace/base" },
      { name: "workspace/base", type: "file", body: "report", mode: 0o640 },
    ],
    async (root) => {
      expect(await readFile(join(root, "first"), "utf8")).toBe("report");
      expect((await stat(join(root, "first"))).ino).not.toBe(
        (await stat(join(root, "base"))).ino,
      );
      await writeFile(join(root, "first"), "changed");
      expect(await readFile(join(root, "base"), "utf8")).toBe("report");
    },
  );
});
// 错误示范：直接link(target, path)或跟随符号链接，会把容器路径变成宿主访问。
test.each(
  (
    [
      [{ name: "workspace/bad", type: "link", linkname: "/etc/passwd" }],
      [
        {
          name: "workspace/bad",
          type: "link",
          linkname: "workspace/../outside",
        },
      ],
      [{ name: "workspace/bad", type: "link", linkname: "workspace/missing" }],
      [{ name: "workspace/bad", type: "link", linkname: "workspace/bad" }],
      [
        { name: "workspace/sym", type: "symlink", linkname: "/etc/passwd" },
        { name: "workspace/bad", type: "link", linkname: "workspace/sym" },
      ],
      [
        { name: "workspace/dir", type: "link", linkname: "workspace/base" },
        { name: "workspace/dir/child", type: "file", body: "bad" },
        { name: "workspace/base", type: "file", body: "safe" },
      ],
    ] as HeaderArgument[][]
  ).map((entries) => [entries]),
)("拒绝危险硬链接并给出条目信息 %#", async (entries) => {
  await expect(exported(entries, async () => {})).rejects.toThrow(
    /归档.*(?:bad|dir)/,
  );
});

// 归档只有一份正文，展开后的硬链接副本也必须占用累计预算。
test("硬链接展开和普通文件共享容量预算，条目数独立限制", async () => {
  const entries: (HeaderArgument & { body?: string })[] = [
    { name: "workspace/base", type: "file", body: "1234" },
    { name: "workspace/copy", type: "link", linkname: "workspace/base" },
  ];
  await expect(
    exported(entries, async () => {}, { maxExportBytes: 7 }),
  ).rejects.toThrow("展开容量");
  await exported(
    entries,
    async (root) => {
      expect(await readFile(join(root, "copy"), "utf8")).toBe("1234");
    },
    { maxExportBytes: 8, maxExportEntries: 2 },
  );
  await expect(
    exported(entries, async () => {}, { maxExportEntries: 1 }),
  ).rejects.toThrow("归档条目失败");
});
