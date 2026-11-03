import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

// 两种结果采集共用限制；初始项目快照保留既有行为，不按大小静默忽略。
export const MAX_EXPORT_FILE_BYTES = 256 * 1024 * 1024;

// 普通文件通过 O_NOFOLLOW 打开，前后元数据变化时立即失败，避免生成混合快照。
export async function hashStable(
  root: string,
  path: string,
  consume?: (chunk: Buffer) => Promise<void>,
  maxFileBytes = Infinity,
): Promise<{ hash: string; size: number }> {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`文件路径非法: ${path}`);
  let parent = await open(
    await realpath(root),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    // Linux procfd 固定已打开的父目录，逐层 O_NOFOLLOW，拒绝祖先链接竞态。
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.close();
      parent = next;
    }
    const fd = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await fd.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`不支持的文件: ${path}`);
      if (
        before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        Number(before.size) > maxFileBytes
      )
        throw new Error(`单文件采集超限 (${maxFileBytes} 字节): ${path}`);
      const hash = createHash("sha256");
      let size = 0;
      // 错误示范：readFile会按沙箱文件大小分配宿主内存；固定缓冲区并检查增长。
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxFileBytes)
          throw new Error(`单文件采集超限 (${maxFileBytes} 字节): ${path}`);
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await consume?.(chunk);
      }
      const after = await fd.stat({ bigint: true });
      if (
        BigInt(size) !== after.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error(`复制期间文件变化: ${path}`);
      return { hash: hash.digest("hex"), size };
    } finally {
      await fd.close();
    }
  } finally {
    await parent.close();
  }
}

// 需要文本合并或展示的调用仍返回Buffer；扫描和快照使用流式接口。
export async function readStable(root: string, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await hashStable(root, path, async (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}
