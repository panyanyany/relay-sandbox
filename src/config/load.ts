import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  configSchema,
  profileSchema,
  type Config,
  type Profile,
} from "./schema.js";
import { digest } from "../storage/hash.js";

// 仅在配置文件确实不存在时使用默认值，其余错误保留原始原因。
export async function loadConfig(project: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(project, "relay-sandbox.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return configSchema.parse({});
    throw error;
  }
  return configSchema.parse(parse(text));
}
// 模型档案来自可信宿主目录，不从内层项目解析命令或镜像权限。
export async function loadProfile(
  home: string,
  name: string,
): Promise<Profile> {
  if (!/^[\w-]+$/.test(name)) throw new Error("模型档案标识非法");
  return profileSchema.parse(
    parse(await readFile(join(home, "profiles", `${name}.yaml`), "utf8")),
  );
}
export const configDigest = (config: Config): string =>
  digest(JSON.stringify(config));
