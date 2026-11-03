import { formatError } from "../audit/redaction.js";
import { developmentAdapter } from "../agents/development/adapters.js";
import { resolveProject } from "../projects/registry.js";
import { loadConfig, loadProfile } from "./load.js";
import { credentialSaveStatus } from "./credentials.js";
import { checkRelayConfiguration } from "./relay-check.js";

// 写入前使用实际适配器校验，协议错误不能留下已替换的凭据。
export async function credentialTarget(home: string, project: string) {
  const config = await loadConfig(await resolveProject(home, project));
  const profile = await loadProfile(home, config.developmentAgent.profile);
  developmentAdapter(config.developmentAgent.type).launch(
    "配置检查",
    profile,
    "configuration-check-placeholder",
  );
  return profile;
}
// 保存后检查失败仍明确报告已保存，并保留脱敏堆栈和原因链。
export async function credentialOutcome(
  home: string,
  project: string,
  saved: boolean,
  variable: string,
  key = "",
  cleanup?: () => Promise<void>,
) {
  let stage = "template_cleanup";
  try {
    await cleanup?.();
    stage = "local_check";
    const check = await checkRelayConfiguration(home, project);
    const overridden = saved && check.credential.source === "environment";
    return {
      project,
      agent: check.agent,
      check,
      credential: check.credential,
      credentialUpdate: credentialSaveStatus(saved, check.credential.source),
      nextAction: overridden
        ? "resolve_credential_override"
        : check.ready
          ? "ready"
          : "resolve_local_check",
      userAction: overridden
        ? "新密钥已保存，但环境变量优先，实际仍使用环境注入凭据；请处理覆盖后重新检查"
        : check.ready
          ? "本机配置检查通过，将用于新任务；尚未联网验证"
          : "配置已保存，请处理本机检查指出的缺失项",
    };
  } catch (error) {
    const source = process.env[variable]
      ? ("environment" as const)
      : saved
        ? ("private_file" as const)
        : ("missing" as const);
    return {
      project,
      check: {
        ready: false,
        issues: ["setup_completion_failed"],
        diagnostics: [{ stage, error: formatError(error, key ? [key] : []) }],
      },
      credentialUpdate: credentialSaveStatus(saved, source),
      nextAction: "resolve_local_check",
      userAction: saved
        ? "密钥已保存，但收尾失败；请根据诊断重试检查"
        : "收尾失败，请根据诊断处理",
    };
  }
}
