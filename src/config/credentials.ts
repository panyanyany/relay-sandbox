import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJson } from "../storage/files.js";
import type { Profile } from "./schema.js";

const credentialSchema = z
  .object({ version: z.literal(1), key: z.string().min(1) })
  .strict();
function credentialPath(home: string, variable: string) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new Error("凭据变量名非法");
  return join(home, "credentials", `${variable}.json`);
}
// 凭据目录由宿主控制，拒绝链接，避免把私密文件写到其他位置。
async function directory(home: string, create = false) {
  const path = join(home, "credentials");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("凭据目录必须为真实目录");
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error("凭据目录必须为当前用户所有的0700目录");
}
// 环境注入优先；本机私有文件使密钥录入后无需重启 MCP，绝不向工具调用方返回原值。
export async function readCredential(
  home: string,
  profile: Pick<Profile, "apiKeyEnv">,
) {
  const injected = process.env[profile.apiKeyEnv];
  if (injected) return { key: injected, source: "environment" as const };
  try {
    await directory(home);
    const handle = await open(
      credentialPath(home, profile.apiKeyEnv),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        (info.mode & 0o777) !== 0o600 ||
        info.uid !== process.getuid?.()
      )
        throw new Error("凭据必须为当前用户所有的0600普通文件");
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile("utf8"));
      } catch {
        throw new Error("凭据文件不是有效JSON；为保护密钥不回显原始内容");
      }
      const parsed = credentialSchema.safeParse(value);
      if (!parsed.success) throw new Error("凭据文件结构无效");
      return { key: parsed.data.key, source: "private_file" as const };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
// 隐藏录入、私有模板及用户主动提供的密钥共用；不写入项目或模型档案。
export async function saveCredential(
  home: string,
  variable: string,
  key: string,
) {
  const path = credentialPath(home, variable);
  const value = credentialSchema.parse({ version: 1, key });
  await directory(home, true);
  // 允许修复损坏内容，但不能绕过文件归属、权限及链接检查。
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error("凭据必须为当前用户所有的0600普通文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJson(path, value);
}

// 保存成功不代表新值生效；环境注入的优先级保持不变。
export function credentialSaveStatus(
  saved: boolean,
  source: "environment" | "private_file" | "missing",
) {
  return {
    saved,
    effectiveSource: source,
    applied: saved && source === "private_file",
    warnings:
      saved && source === "environment"
        ? ["environment_overrides_saved_credential"]
        : [],
  };
}
