import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { agentType } from "./schema.js";
import { relaySetupSchema } from "./relay-setup.js";
import { validateId } from "../projects/registry.js";

const templateSchema = z
  .object({
    metadata: z
      .object({
        configurationDigest: z.string().optional(),
        projectId: z.string(),
        root: z.string(),
        createdAt: z.string().nullable(),
        updatedAt: z.string().nullable(),
      })
      .strict(),
    agent: agentType,
    endpoint: relaySetupSchema.shape.endpoint,
    model: z.string().min(1),
    apiKey: z.string().trim(),
  })
  .strict();

// 模板只能位于宿主私有目录，拒绝链接；不接受任意文件读取路径。
export async function templatePath(home: string, project: string) {
  validateId(project);
  const dir = join(home, "setup");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("配置模板目录必须为当前用户所有的0700真实目录");
  return join(dir, `${project}.yaml`);
}
// 固定错误说明不拼接解析器异常：YAML解析错误可能包含整行密钥。
export function checkedTemplate(text: string, draft = false) {
  let value: unknown;
  try {
    // 错误示范：parse()的警告会绕过catch，将含密钥的源行直接写入stderr。
    const doc = parseDocument(text);
    if (doc.errors.length || doc.warnings.length) throw new Error("无效模板");
    value = doc.toJS();
  } catch {
    throw new Error("模板YAML格式无效，请检查缩进；为保护密钥不回显内容");
  }
  const schema = draft
    ? templateSchema.extend({ endpoint: z.string(), model: z.string() })
    : templateSchema;
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = [
      ...new Set(
        result.error.issues.map((issue) =>
          ["metadata", "agent", "endpoint", "model", "apiKey"].includes(
            String(issue.path[0]),
          )
            ? String(issue.path[0])
            : "结构",
        ),
      ),
    ];
    throw new Error(`模板字段无效：${fields.join("、")}；请填写全部必要字段`);
  }
  return result.data;
}
export async function privateFile(file: Awaited<ReturnType<typeof open>>) {
  const info = await file.stat();
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  )
    throw new Error("配置模板必须为当前用户所有的0600普通文件");
  if (info.size > 65536) throw new Error("配置模板不能超过64KiB");
}

// 缺少基线的旧模板也必须重新核对，不能默默覆盖当前配置。
export function assertTemplateBaseline(
  stored: string | undefined,
  current: string,
) {
  if (stored !== current)
    throw new Error(
      "模板配置基线已过期或缺失；请将原文件移至私有备份，再生成新模板并核对需要保留的内容",
    );
}
