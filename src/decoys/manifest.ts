import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import type { HostPermissions } from "../permissions/types.js";

export const DECOY_DIRECTORY = "/home/node/.config/relay-sandbox/decoys";
const entrySchema = z
  .object({
    id: z.enum(["aws-01", "openrouter-01"]),
    provider: z.enum(["aws", "openrouter"]),
    path: z.string(),
    value: z.string().regex(/^RELAY_SANDBOX_FAKE_[A-Z]+_[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    enabled: z.boolean(),
    entries: z.array(entrySchema),
  })
  .strict();
export type DecoyManifest = z.infer<typeof manifestSchema>;
const definitions = [
  { id: "aws-01", provider: "aws", path: `${DECOY_DIRECTORY}/aws.credentials` },
  {
    id: "openrouter-01",
    provider: "openrouter",
    path: `${DECOY_DIRECTORY}/openrouter.credentials`,
  },
] as const;

// 校验私密清单身份和固定隔离路径；坏文件不能被重新生成掩盖。
function validateManifest(
  input: unknown,
  taskId: string,
  enabled: boolean,
): DecoyManifest {
  const manifest = manifestSchema.parse(input);
  if (manifest.taskId !== taskId || manifest.enabled !== enabled)
    throw new Error("诱饵清单与任务或冻结开关不一致");
  const expected = enabled ? definitions : [];
  if (
    manifest.entries.length !== expected.length ||
    expected.some((definition, index) => {
      const entry = manifest.entries[index]!;
      return (
        entry.id !== definition.id ||
        entry.provider !== definition.provider ||
        entry.path !== definition.path
      );
    })
  )
    throw new Error("诱饵清单目标不符合隔离规则");
  return manifest;
}

// 清单路径由可信宿主任务目录提供；同任务再次调用不会重新生成值。
export async function ensureDecoyManifest(
  privatePath: string,
  taskId: string,
  policy: HostPermissions["decoys"],
): Promise<DecoyManifest> {
  if (!taskId) throw new Error("诱饵任务编号不能为空");
  try {
    const info = await lstat(privatePath);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600)
      throw new Error("诱饵清单必须为0600普通文件");
    const handle = await open(
      privatePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return validateManifest(
        JSON.parse(await handle.readFile("utf8")),
        taskId,
        policy.enabled,
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // 关闭时不生成随机值、不创建文件、不要求代理或客户端已配置。
  if (!policy.enabled)
    return { schemaVersion: 1, taskId, enabled: false, entries: [] };
  const manifest: DecoyManifest = {
    schemaVersion: 1,
    taskId,
    enabled: true,
    entries: definitions.map((definition) => ({
      ...definition,
      value: `RELAY_SANDBOX_FAKE_${definition.provider.toUpperCase()}_${randomBytes(32).toString("hex")}`,
    })),
  };
  // 明确无效前缀，绝不使用真实服务认可的密钥格式或创建云端资源。
  const handle = await open(privatePath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(manifest));
  } finally {
    await handle.close();
  }
  return manifest;
}

// 对外仅暴露编号和位置；是否实际安装由上传完成后的调用方确认。
export function publicDecoySummary(manifest: DecoyManifest) {
  return {
    enabled: manifest.enabled,
    discovery: "low-discoverability-independent-files" as const,
    entries: manifest.entries.map(({ id, path }) => ({
      id,
      path,
      status: "planned" as const,
    })),
  };
}
