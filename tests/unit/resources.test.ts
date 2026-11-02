import {
  mkdtemp,
  mkdir,
  readFile,
  link,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { FileResource } from "../../src/permissions/types.js";
import { validateResources } from "../../src/resources/paths.js";
import { copyResources } from "../../src/resources/copy.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-resource-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "data"), "original");
  return { root, source };
}
function grant(source: string, rest: Partial<FileResource> = {}): FileResource {
  return {
    name: "cache",
    source,
    target: "/resources/cache",
    mode: "copy",
    access: "read-write",
    ...rest,
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 副本必须真实分离，清理任务目录后授权源仍存在。
test("副本修改和清理不影响授权源，直接资源保持原路径", async () => {
  const { root, source } = await fixture();
  const privateRoot = join(root, "private");
  const [copy] = await copyResources([grant(source)], privateRoot);
  await writeFile(join(copy!.source, "data"), "changed");
  expect(await readFile(join(source, "data"), "utf8")).toBe("original");
  await rm(privateRoot, { recursive: true });
  expect(await readFile(join(source, "data"), "utf8")).toBe("original");
  const [direct] = await validateResources([grant(source, { mode: "direct" })]);
  expect(direct!.source).toBe(source);
});
// 不允许链接把未授权数据带入额外资源，也不允许目标遮蔽任务控制面。
test("拒绝链接、保留目标、目标重叠和宿主控制目录", async () => {
  const { root, source } = await fixture();
  for (const target of [
    "/",
    "/workspace/config",
    "/proc",
    "/run/key",
    "/opt/relay",
  ]) {
    await expect(
      validateResources([grant(source, { target })]),
    ).rejects.toThrow();
  }
  await expect(
    validateResources([
      grant(source),
      grant(source, { name: "nested", target: "/resources/cache/sub" }),
    ]),
  ).rejects.toThrow();
  await expect(validateResources([grant(source)], [root])).rejects.toThrow();
  await symlink(source, join(root, "alias"));
  await expect(
    validateResources([grant(join(root, "alias"))]),
  ).rejects.toThrow();
  await symlink("/etc/passwd", join(source, "escape"));
  await expect(
    copyResources([grant(source)], join(root, "private")),
  ).rejects.toThrow();
  await expect(readFile(join(root, "private/cache/escape"))).rejects.toThrow();
});

// 即使授权读取文件，也不能经硬链接或把副本放回源内扩大写入范围。
test("拒绝硬链接及源内副本目录", async () => {
  const { source, root } = await fixture();
  await expect(
    copyResources([grant(source)], join(source, "private")),
  ).rejects.toThrow("重叠");
  await expect(readFile(join(source, "private"))).rejects.toThrow();
  await link(join(source, "data"), join(root, "linked"));
  await expect(validateResources([grant(source)])).rejects.toThrow("硬链接");
});
