import { ExportBudget, type ExportLimits } from "./export-budget.js";
import {
  archivePath,
  materializeLinks,
  type ArchiveEntry,
} from "./archive-links.js";
import { MAX_EXPORT_FILE_BYTES } from "../workspace/stable-file.js";
import { PassThrough, type Readable } from "node:stream";
import { pack, extract } from "tar-stream";
import { mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import type Docker from "dockerode";
import { scan, readStable } from "../workspace/manifest.js";

// 归档仅从任务副本生成，显式固定 UID，不把宿主原路径传入容器。
export async function upload(
  docker: Docker,
  id: string,
  root: string,
  target = "/workspace",
): Promise<void> {
  const archive = pack();
  const bridge = new PassThrough();
  archive.pipe(bridge);
  const operation = docker
    .getContainer(id)
    .putArchive(bridge, { path: target });
  try {
    for (const entry of await scan(root)) {
      const header = {
        name: entry.path,
        uid: 1000,
        gid: 1000,
        mode: entry.mode,
      };
      const data =
        entry.type === "file"
          ? await readStable(root, entry.path)
          : Buffer.alloc(0);
      await new Promise<void>((resolve, reject) =>
        archive.entry(
          {
            ...header,
            type: entry.type,
            ...(entry.link ? { linkname: entry.link } : {}),
          },
          data,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
    archive.finalize();
    await operation;
  } catch (error) {
    archive.destroy();
    await operation.catch(() => undefined);
    throw error;
  }
}
// 先收集归档到全新目录；拒绝重复项、特殊类型、路径穿越及链接祖先。
export async function download(
  docker: Docker,
  id: string,
  target: string,
  limits: ExportLimits = {},
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const archive = extract();
  const budget = new ExportBudget(limits);
  const seen = new Map<string, ArchiveEntry>();
  const links = new Set<string>();
  const modes: { path: string; mode: number }[] = [];
  archive.on("entry", (header, stream, next) => {
    stream.on("error", (error) => archive.destroy(error));
    void (async () => {
      const raw = header.name
        .replace(/^(?:workspace|\.)(?:\/|$)/, "")
        .replace(/\/$/, "");
      const name = raw ? archivePath(header.name) : "";
      if (!name) {
        stream.resume();
        next();
        return;
      }
      budget.entry();
      const parts = name.split("/");
      if (
        name.startsWith("/") ||
        parts.some((p) => !p || p === "." || p === "..") ||
        seen.has(name)
      )
        throw new Error("危险或重复归档条目");
      if (parts.some((_, i) => links.has(parts.slice(0, i).join("/"))))
        throw new Error(`归档条目试图穿过链接: ${name}`);
      seen.set(name, { type: header.type ?? "file" });
      const path = join(target, name);
      await mkdir(dirname(path), { recursive: true });
      if (header.type === "directory") {
        await mkdir(path, { recursive: true });
        modes.push({ path, mode: header.mode });
      } else if (header.type === "symlink") {
        await symlink(header.linkname!, path);
        links.add(name);
      } else if (header.type === "link") {
        const target = archivePath(header.linkname ?? "");
        seen.set(name, { type: "link", target });
        links.add(name);
      } else if (header.type === "file") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value)
            ? value
            : Buffer.from(value as Uint8Array);
          size += chunk.length;
          budget.reserve(chunk.length);
          if (size > MAX_EXPORT_FILE_BYTES)
            throw new Error("单文件导出超过 256MiB，请调整配置或拆分文件");
          chunks.push(chunk);
        }
        await writeFile(path, Buffer.concat(chunks), {
          mode: header.mode,
          flag: "wx",
        });
      } else
        throw new Error(
          `不支持的归档类型: ${header.type}, 条目: ${header.name}, 目标: ${header.linkname ?? "无"}`,
        );
      stream.resume();
      next();
    })().catch((error) =>
      archive.destroy(
        new Error(
          `归档条目失败: ${header.name}, 类型: ${header.type}, 目标: ${header.linkname ?? "无"}`,
          { cause: error },
        ),
      ),
    );
  });
  const source = await docker
    .getContainer(id)
    .getArchive({ path: "/workspace/." });
  try {
    await new Promise<void>((resolve, reject) => {
      archive.on("finish", resolve);
      archive.on("error", reject);
      source.on("error", reject);
      source.pipe(archive);
    });
  } finally {
    (source as Readable).destroy();
    archive.destroy();
  }
  await materializeLinks(target, seen, budget);
  for (const entry of modes.reverse()) await chmod(entry.path, entry.mode);
}
