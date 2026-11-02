import { readdir, readFile } from "node:fs/promises";
// 按真实行数检查手写源码，不通过去掉注释压缩行数。
async function inspect(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!/\.(ts|js|mjs|py)$/.test(path)) continue;
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n").length;
    if (lines >= 500) throw new Error(`${path}: ${lines} 行，必须少于 500 行`);
  }
}
await Promise.all(["src", "tests", "scripts"].map(inspect));
