import { readFile, stat, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../storage/hash.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { agentType, configSchema, profileSchema } from "./schema.js";
import { loadConfig, loadProfile } from "./load.js";
import {
  resolveProject,
  validateId,
  registerProjectLocked,
  projectMetadata,
} from "../projects/registry.js";
import { dockerClient } from "../docker/client.js";
import { readCredential, saveCredential } from "./credentials.js";
import { withProjectSetupLock } from "../projects/lock.js";

export const relaySetupSchema = z
  .object({
    project: z.string(),
    agent: agentType,
    endpoint: profileSchema.shape.endpoint,
    model: z.string().min(1),
  })
  .strict();
const protocols = {
  codex: "responses",
  "claude-code": "anthropic",
  opencode: "openai-compatible",
} as const;
// 返回可直接复制的本机命令，目录有空格也可正确执行；命令不包含密钥。
function localCommand(home: string, ...args: string[]) {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(
    new URL(source ? "../cli/main.ts" : "../cli/main.js", import.meta.url),
  );
  return [
    process.execPath,
    ...(source ? ["--import", "tsx"] : []),
    entry,
    "--home",
    home,
    ...args,
  ]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
}
// 缺少档案可引导首次配置；损坏档案仍明确报错，不能被当作未配置覆盖。
async function optionalProfile(home: string, name: string) {
  try {
    return await loadProfile(home, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function relayConfiguration(home: string, project: string) {
  const config = await loadConfig(await resolveProject(home, project));
  const profile = await optionalProfile(home, config.developmentAgent.profile);
  const credential = profile ? await readCredential(home, profile) : undefined;
  return {
    project,
    metadata: await projectMetadata(home, project),
    agent: config.developmentAgent.type,
    profile: config.developmentAgent.profile,
    configured: !!profile,
    endpoint: profile
      ? new URL(profile.endpoint).origin + new URL(profile.endpoint).pathname
      : null,
    model: profile?.model ?? null,
    protocol: profile?.protocol ?? null,
    credential: {
      ready: !!credential,
      source: credential?.source ?? ("missing" as const),
      apiKeyEnv: profile?.apiKeyEnv ?? null,
      command: profile ? localCommand(home, "credential-set", project) : null,
      prepareFile: {
        tool: "initialize_relay",
        arguments: { project, mode: "file" },
      },
    },
    nextAction: !profile
      ? "configure_relay"
      : !credential
        ? "initialize_relay"
        : "check_relay_configuration",
  };
}
// 查询只枚举已注册项目；首次目录授权和注册由独立初始化入口处理。
export async function registeredRelayProjects(home: string) {
  let names: string[];
  try {
    names = await readdir(join(home, "projects"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  const projects = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const project = name.slice(0, -5);
        validateId(project);
        const config = await loadConfig(await resolveProject(home, project));
        return {
          project,
          metadata: await projectMetadata(home, project),
          agent: config.developmentAgent.type,
          profile: config.developmentAgent.profile,
        };
      }),
  );
  return {
    projects,
    nextAction: projects.length ? "select_project" : "initialize_relay",
    registrationCommand: localCommand(
      home,
      "register",
      "<项目标识>",
      "<项目绝对路径>",
    ),
  };
}
// 原子替换并保留YAML注释和其他配置；错误示范：重写整个配置会误改交付与资源策略。
async function writeYaml(path: string, text: string, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { flag: "wx", mode });
  await rename(temp, path);
}
// 每项目使用独立档案；不修改共享档案，不允许MCP传入镜像、挂载或任意命令。
export async function configureRelay(
  home: string,
  input: z.infer<typeof relaySetupSchema>,
) {
  return withProjectSetupLock(home, input.project, () =>
    configureRelayLocked(home, input).then(() =>
      relayConfiguration(home, input.project),
    ),
  );
}
// 内部保存入口要求调用方已持有项目配置锁，导入流程在凭据和模板收尾后才释放。
export async function configureRelayLocked(
  home: string,
  input: z.infer<typeof relaySetupSchema>,
  replacingCredential = false,
) {
  const checked = relaySetupSchema.parse(input);
  const endpoint = new URL(checked.endpoint);
  if (endpoint.search || endpoint.hash)
    throw new Error("中转基础地址不能包含查询凭据或片段");
  const root = await resolveProject(home, checked.project);
  const config = await loadConfig(root);
  const name = `project-${checked.project}`;
  const own = await optionalProfile(home, name);
  const existing =
    own ?? (await optionalProfile(home, config.developmentAgent.profile));
  const image =
    existing?.image ??
    (await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()).Id;
  const profile = profileSchema.parse({
    endpoint: checked.endpoint,
    model: checked.model,
    apiKeyEnv:
      own?.apiKeyEnv ??
      `RELAY_${checked.project.toUpperCase().replaceAll("-", "_")}_${digest(checked.project).slice(0, 8).toUpperCase()}_KEY`,
    protocol: protocols[checked.agent],
    image,
    networkImage: existing?.networkImage ?? image,
  });
  const path = join(root, "relay-sandbox.yaml");
  let text = "";
  let projectMode = 0o644;
  try {
    text = await readFile(path, "utf8");
    projectMode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error("项目YAML无效，请先修复配置");
  doc.setIn(["developmentAgent", "type"], checked.agent);
  doc.setIn(["developmentAgent", "profile"], name);
  configSchema.parse(doc.toJS());
  // 新档案只继承凭据值，不继承共享存储槽；错误示范：继承变量名会跨项目覆盖。
  if (
    !replacingCredential &&
    !own &&
    existing &&
    !(await readCredential(home, profile))
  ) {
    const inherited = await readCredential(home, existing);
    if (inherited) await saveCredential(home, profile.apiKeyEnv, inherited.key);
  }
  await writeYaml(join(home, "profiles", `${name}.yaml`), stringify(profile));
  await writeYaml(path, doc.toString(), projectMode);
  await registerProjectLocked(home, checked.project, root);
  return profile;
}

// 模板基线只覆盖非秘密配置；凭据替换不会制造配置冲突。
export async function relayConfigurationDigest(home: string, project: string) {
  const config = await loadConfig(await resolveProject(home, project));
  const profile = await optionalProfile(home, config.developmentAgent.profile);
  return digest(
    JSON.stringify({
      agent: config.developmentAgent,
      profile: profile ?? null,
    }),
  );
}
