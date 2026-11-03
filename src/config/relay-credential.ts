import { withProjectSetupLock } from "../projects/lock.js";
import { saveCredential } from "./credentials.js";
import { credentialTarget, credentialOutcome } from "./relay-outcome.js";
import { z } from "zod";

export const suppliedCredentialSchema = z.string().trim().min(1);
export const credentialHistoryNotice =
  "聊天或工具调用记录可能保留密钥；工具侧脱敏不能删除这些记录。";
// 用户主动提供密钥时直接保存；与初始化共用锁内路径，不需要再运行CLI。
export async function setRelayCredential(
  home: string,
  project: string,
  apiKey: string,
) {
  const key = suppliedCredentialSchema.parse(apiKey);
  return withProjectSetupLock(home, project, () =>
    completeCredentialSetup(home, project, key),
  );
}
// 调用方已持有项目配置锁；默认只做本机检查，不发送模型请求。
export async function completeCredentialSetup(
  home: string,
  project: string,
  apiKey: string,
) {
  const profile = await credentialTarget(home, project);
  await saveCredential(home, profile.apiKeyEnv, apiKey);
  return {
    ...(await credentialOutcome(
      home,
      project,
      true,
      profile.apiKeyEnv,
      apiKey,
    )),
    securityNotice: credentialHistoryNotice,
  };
}
