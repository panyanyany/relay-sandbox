import { formatError } from "../audit/redaction.js";
import { resolveProject } from "../projects/registry.js";
import { dockerClient } from "../docker/client.js";
import { loadConfig, loadProfile } from "./load.js";
import { readCredential } from "./credentials.js";
import { developmentAdapter } from "../agents/development/adapters.js";
import { relayConfiguration } from "./relay-setup.js";

// 默认只检查本机配置与镜像；显式联网时才发送小请求，响应正文不进入日志或MCP结果。
export async function checkRelayConfiguration(
  home: string,
  project: string,
  testConnection = false,
) {
  const configuration = await relayConfiguration(home, project);
  const issues: string[] = [];
  const diagnostics: { stage: string; error: string }[] = [];
  if (!configuration.configured)
    return {
      ...configuration,
      ready: false,
      issues: ["profile_missing"],
      connection: { tested: false },
    };
  const config = await loadConfig(await resolveProject(home, project));
  const profile = await loadProfile(home, config.developmentAgent.profile);
  const credential = await readCredential(home, profile);
  if (!credential) issues.push("credential_missing");
  // 使用真实适配器校验协议，避免配置检查与实际运行各维护一套规则。
  developmentAdapter(config.developmentAgent.type).launch(
    "配置检查",
    profile,
    "configuration-check-placeholder",
  );
  for (const image of new Set([profile.image, profile.networkImage])) {
    try {
      await dockerClient().getImage(image).inspect();
    } catch (error) {
      issues.push("local_image_unavailable");
      diagnostics.push({ stage: "image", error: formatError(error) });
    }
  }
  if (!testConnection || !credential || issues.length)
    return {
      ...configuration,
      ready: issues.length === 0,
      issues,
      diagnostics,
      connection: { tested: false },
    };
  const base = profile.endpoint.replace(/\/+$/, "");
  const path =
    profile.protocol === "anthropic"
      ? `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`
      : `${base}/${profile.protocol === "responses" ? "responses" : "chat/completions"}`;
  const body =
    profile.protocol === "responses"
      ? { model: profile.model, input: "ping", max_output_tokens: 16 }
      : {
          model: profile.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        };
  try {
    const response = await fetch(path, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        ...(profile.protocol === "anthropic"
          ? { "x-api-key": credential.key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${credential.key}` }),
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
    await response.body?.cancel();
    return {
      ...configuration,
      ready: response.ok,
      issues: response.ok ? [] : ["relay_http_error"],
      connection: { tested: true, ok: response.ok, status: response.status },
    };
  } catch (error) {
    // 保留脱敏原因链定位网络故障，响应正文与请求头始终不回传。
    return {
      ...configuration,
      ready: false,
      issues: ["relay_connection_failed"],
      diagnostics: [
        { stage: "connection", error: formatError(error, [credential.key]) },
      ],
      connection: { tested: true, ok: false },
    };
  }
}
