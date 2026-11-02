import { auditedClientSchema } from "../permissions/schema.js";
import type { AuditedClient, FrozenPolicy } from "../permissions/types.js";

// 仅列出经本项目真实入口测试的组合，不代表其他调用或工具版本可解密。
export const VERIFIED_CLIENTS: AuditedClient[] = [
  {
    id: "urllib-3-11-2",
    tool: "python",
    version: "3.11.2",
    library: "urllib.request@3.11.2",
    trustStore: "explicit-ca-file",
    invocation: ["python", "urllib.request"],
  },
  {
    id: "curl-7-88-1",
    tool: "curl",
    version: "7.88.1",
    trustStore: "explicit-ca-file",
    invocation: ["curl", "--disable"],
  },
  {
    id: "wget-1-21-3",
    tool: "wget",
    version: "1.21.3",
    trustStore: "explicit-ca-file",
    invocation: ["wget", "--no-config"],
  },
];
// 只准备公开配置；脚本和公CA由任务编排器上传，不暴露清单原值或代理私钥。
export function prepareClientCatalog(
  policy: FrozenPolicy,
  endpoint: string,
  caPath: string,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error("受控客户端只使用任务内回环代理");
  if (!caPath.startsWith("/") || caPath.includes("\0"))
    throw new Error("公CA路径必须是绝对路径");
  return {
    schemaVersion: 1 as const,
    endpoint,
    caPath,
    clients: policy.decoys.enabled
      ? policy.decoys.clients.map((client) => auditedClientSchema.parse(client))
      : [],
  };
}
