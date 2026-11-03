import {
  completeCredentialSetup,
  suppliedCredentialSchema,
} from "./relay-credential.js";
import {
  templatePath,
  checkedTemplate,
  privateFile,
  assertTemplateBaseline,
} from "./relay-template.js";
import { withProjectSetupLock } from "../projects/lock.js";
import { constants } from "node:fs";
import { open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Document, isNode } from "yaml";
import { z } from "zod";
import { agentType } from "./schema.js";
import {
  configureRelayLocked,
  relayConfigurationDigest,
  relaySetupSchema,
  relayConfiguration,
} from "./relay-setup.js";
import { saveCredential } from "./credentials.js";
import { checkRelayConfiguration } from "./relay-check.js";
import {
  projectMetadata,
  registerProjectLocked,
  registeredProject,
  resolveProject,
  validateId,
} from "../projects/registry.js";
import { credentialTarget, credentialOutcome } from "./relay-outcome.js";

export const initializeSchema = z
  .object({
    project: z.string(),
    projectPath: z.string().optional(),
    confirmProject: z.boolean().default(false),
    mode: z.enum(["conversation", "file"]).default("conversation"),
    agent: agentType.optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    apiKey: suppliedCredentialSchema.optional(),
  })
  .strict()
  .refine(
    (input) => !(input.mode === "file" && input.apiKey !== undefined),
    "主动提供密钥时请使用conversation模式",
  );
// 注册是明确的宿主授权步骤；错误示范：静默覆盖已有标识会将任务导向其他项目。
async function ensureProject(
  home: string,
  input: z.infer<typeof initializeSchema>,
) {
  validateId(input.project);
  const entry = await registeredProject(home, input.project);
  // 已有记录的目录失效必须报错，不能吞掉realpath的ENOENT后改绑项目。
  const registered = entry ? await realpath(entry.root) : undefined;
  if (input.projectPath) {
    if (!isAbsolute(input.projectPath))
      throw new Error("项目目录必须是绝对路径");
    const root = await realpath(input.projectPath);
    if (registered && registered !== root)
      throw new Error("项目标识已属于其他目录，请选择新标识");
    if (!registered) {
      if (!input.confirmProject)
        throw new Error(
          "请先取得用户对该项目目录的明确授权，再设置confirmProject=true",
        );
      await registerProjectLocked(home, input.project, root);
    }
  } else if (!registered) throw new Error("首次初始化需要用户选择项目目录");
}
// 对话允许用户主动提供密钥；未提供时同时准备隐藏录入命令和私有文件。
export async function initializeRelay(
  home: string,
  raw: z.input<typeof initializeSchema>,
) {
  const input = initializeSchema.parse(raw);
  return withProjectSetupLock(home, input.project, () =>
    initializeLocked(home, input),
  );
}
async function initializeLocked(
  home: string,
  input: z.infer<typeof initializeSchema>,
) {
  if (input.mode === "conversation") {
    const settings = relaySetupSchema.parse({
      project: input.project,
      agent: input.agent ?? "claude-code",
      endpoint: input.endpoint,
      model: input.model,
    });
    await ensureProject(home, input);
    await configureRelayLocked(home, settings, !!input.apiKey);
    if (input.apiKey) {
      const outcome = await completeCredentialSetup(
        home,
        input.project,
        input.apiKey,
      );
      return { ...outcome.check, ...outcome };
    }
    const configuration = await relayConfiguration(home, input.project);
    const check = await checkRelayConfiguration(home, input.project);
    const entry = !check.credential.ready
      ? await prepareTemplate(home, { ...input, mode: "file" })
      : undefined;
    return {
      ...configuration,
      check,
      credentialFile: entry?.file ?? null,
      userAction: check.ready
        ? "本机配置检查通过，将用于新任务；尚未联网验证"
        : configuration.credential.ready
          ? "根据本机检查结果处理缺失项"
          : "可执行credential.command隐藏录入，或直接编辑credentialFile私有配置文件，填好后告诉AI导入",
    };
  }
  return prepareTemplate(home, input);
}
// 不重复录入：返回实际可编辑文件，已有模板保留用户内容。
async function prepareTemplate(
  home: string,
  input: z.infer<typeof initializeSchema>,
) {
  await ensureProject(home, input);
  const path = await templatePath(home, input.project);
  const current = await relayConfiguration(home, input.project);
  const doc = new Document({
    metadata: {
      ...(await projectMetadata(home, input.project)),
      configurationDigest: await relayConfigurationDigest(home, input.project),
    },
    agent: input.agent ?? (current.configured ? current.agent : "claude-code"),
    endpoint: input.endpoint ?? current.endpoint ?? "",
    model: input.model ?? current.model ?? "",
    apiKey: "",
  });
  doc.commentBefore =
    " 本机私有明文配置，勿提交或发送到聊天；导入成功后密钥会清空。";
  for (const [field, comment] of Object.entries({
    metadata: " 所属项目、实际目录及UTC时间，请保留归属信息。",
    agent: " 沙箱内的开发助手。",
    endpoint: " 中转服务基础地址。",
    model: " 服务商提供的模型名称。",
    apiKey: " 专用密钥；留空保留现有凭据，没有可用凭据时必须填写。",
  })) {
    const node = doc.get(field, true);
    if (!isNode(node)) throw new Error("模板字段节点缺失");
    node.commentBefore = comment;
  }
  const content = doc.toString();
  let templateConflict = false;
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // 已有模板可能包含用户尚未导入的密钥，不能覆盖。
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await privateFile(file);
      const existing = checkedTemplate(await file.readFile("utf8"), true);
      templateConflict =
        existing.metadata.configurationDigest !==
        (await relayConfigurationDigest(home, input.project));
    } finally {
      await file.close();
    }
  }
  return {
    project: input.project,
    file: path,
    credential: current.credential,
    templateConflict,
    nextAction: templateConflict
      ? "resolve_template_conflict"
      : "user_edit_private_file",
    userAction: templateConflict
      ? "模板配置基线已过期或缺失；请将原文件移至私有备份，再生成新模板并核对需要保留的内容"
      : "填写此文件中的中转地址、模型和密钥，保存后告诉我“填好了”",
  };
}
// 先验证并保存，再从同一文件句柄清除密钥；校验或保存失败保留输入供重试。
export async function importRelayConfiguration(home: string, project: string) {
  return withProjectSetupLock(home, project, () => importLocked(home, project));
}
async function importLocked(home: string, project: string) {
  await resolveProject(home, project);
  const path = await templatePath(home, project);
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await privateFile(file);
    const settings = checkedTemplate(await file.readFile("utf8"));
    const metadata = await projectMetadata(home, project);
    if (
      settings.metadata.projectId !== project ||
      settings.metadata.root !== metadata.root
    )
      throw new Error("模板所属项目或路径不匹配，请使用该项目生成的模板");
    assertTemplateBaseline(
      settings.metadata.configurationDigest,
      await relayConfigurationDigest(home, project),
    );
    if (
      !settings.apiKey &&
      !(await relayConfiguration(home, project)).credential.ready
    )
      throw new Error("没有可用凭据，请填写apiKey后重试");
    await configureRelayLocked(
      home,
      {
        project,
        agent: settings.agent,
        endpoint: settings.endpoint,
        model: settings.model,
      },
      !!settings.apiKey,
    );
    const profile = await credentialTarget(home, project);
    if (settings.apiKey)
      await saveCredential(home, profile.apiKeyEnv, settings.apiKey);
    return await credentialOutcome(
      home,
      project,
      !!settings.apiKey,
      profile.apiKeyEnv,
      settings.apiKey,
      async () => {
        const clean = Buffer.from(
          "# 已导入；apiKey留空保留现有凭据，填写新值则替换私有文件凭据。\n" +
            new Document({
              ...settings,
              metadata: {
                ...(await projectMetadata(home, project)),
                configurationDigest: await relayConfigurationDigest(
                  home,
                  project,
                ),
              },
              apiKey: "",
            }).toString(),
        );
        await file.write(clean, 0, clean.length, 0);
        await file.truncate(clean.length);
      },
    );
  } finally {
    await file.close();
  }
}
