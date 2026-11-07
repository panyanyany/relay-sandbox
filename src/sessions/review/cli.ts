import { redact } from "../../audit/redaction.js";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEvidence } from "./evidence.js";
import type { ReviewContext } from "./config.js";

// 材料已完整注入 stdin；审查不需要任何文件、命令或网络工具。
export function reviewLaunch(context: ReviewContext, isolatedHome: string) {
  const { configuration: c, profile: p, key } = context;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: isolatedHome,
    CODEX_HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    XDG_DATA_HOME: isolatedHome,
    XDG_CACHE_HOME: isolatedHome,
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (c.agent === "codex") {
    if (p.protocol !== "responses")
      throw new Error("Codex审查要求Responses协议");
    env.RELAY_REVIEW_API_KEY = key;
    return {
      command: "codex",
      env,
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        'web_search="disabled"',
        "-c",
        "mcp_servers={}",
        "-c",
        'model_provider="relay"',
        "-c",
        `model_providers.relay={name="relay",base_url=${JSON.stringify(p.endpoint)},wire_api="responses",env_key="RELAY_REVIEW_API_KEY"}`,
        "--model",
        p.model,
        "-",
      ],
    };
  }
  if (c.agent === "claude-code") {
    if (p.protocol !== "anthropic")
      throw new Error("Claude审查要求Anthropic协议");
    env.ANTHROPIC_BASE_URL = p.endpoint;
    env.ANTHROPIC_API_KEY = key;
    return {
      command: "claude",
      env,
      args: [
        "-p",
        "--output-format",
        "json",
        "--bare",
        "--safe-mode",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--model",
        p.model,
      ],
    };
  }
  if (p.protocol !== "openai-compatible")
    throw new Error("OpenCode审查要求OpenAI兼容协议");
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permission: { "*": "deny" },
    plugin: [],
    provider: {
      relay: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: p.endpoint, apiKey: key },
        models: { [p.model]: {} },
      },
    },
  });
  return {
    command: "opencode",
    env,
    args: ["run", "--pure", "--format", "json", "--model", `relay/${p.model}`],
  };
}
// 只提取明确错误事件的诊断字段，不能把成功的模型正文当成错误输出。
function eventFailure(event: Record<string, unknown>): string | undefined {
  if (
    event.type !== "error" &&
    event.type !== "turn.failed" &&
    event.is_error !== true
  )
    return undefined;
  const error = event.error as Record<string, unknown> | string | undefined;
  const data =
    typeof error === "object" && error !== null
      ? (error.data as Record<string, unknown> | undefined)
      : undefined;
  const messages = [
    event.message,
    typeof error === "string" ? error : error?.message,
    data?.message,
    event.is_error === true ? event.result : undefined,
    ...(Array.isArray(event.errors) ? event.errors : []),
  ];
  return (
    messages
      .filter((value): value is string => typeof value === "string")
      .join("\n") || "审查Agent报告执行失败"
  );
}
// 非零退出仍解析有界 JSONL；损坏行保留解析诊断，不回显未识别的正文。
function failedOutput(output: string): string {
  const failures: string[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event && typeof event === "object") {
        const failure = eventFailure(event);
        if (failure) failures.push(failure);
      }
    } catch (error) {
      failures.push(
        error instanceof Error
          ? (error.stack ?? error.message)
          : "JSONL解析失败",
      );
    }
  }
  return failures.join("\n");
}
// 原生事件仅提取最终助手文本；任何错误事件都不能被退出码0掩盖。
export function reviewOutput(
  agent: ReviewContext["configuration"]["agent"],
  output: string,
  secrets: string[] = [],
) {
  const events = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const texts: string[] = [];
  for (const event of events) {
    const failure = eventFailure(event);
    if (failure) throw new Error(redact(failure, secrets));
    if (
      agent === "claude-code" &&
      event.type === "result" &&
      typeof event.result === "string"
    )
      texts.push(event.result);
    const item = event.item as Record<string, unknown> | undefined;
    if (
      agent === "codex" &&
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    )
      texts.push(item.text);
    const part = event.part as Record<string, unknown> | undefined;
    if (
      agent === "opencode" &&
      event.type === "text" &&
      typeof part?.text === "string"
    )
      texts.push(part.text);
  }
  if (!texts.length) throw new Error("审查Agent没有返回结论");
  return texts.join("\n");
}
// 独立HOME和白名单环境避免继承宿主MCP、开发密钥和会话历史。
export async function runReviewCli(
  prompt: string,
  evidence: ReviewEvidence,
  context: ReviewContext,
) {
  const home = await mkdtemp(join(tmpdir(), "relay-review-"));
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const launch = reviewLaunch(context, home);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: evidence.root,
        env: launch.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        diagnostic = "",
        bytes = 0,
        failure: Error | undefined;
      const kill = (error: Error) => {
        failure ??= error;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              reject(error);
          }
        }
      };
      const timer = setTimeout(
        () => kill(new Error("独立审查超时；审查未完成")),
        context.configuration.timeoutMs,
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > context.configuration.maxOutputBytes)
          kill(new Error("审查输出超过预算"));
        else output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > context.configuration.maxOutputBytes)
          kill(new Error("审查输出超过预算"));
        else diagnostic += chunk.toString();
      });
      child.stdin.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") kill(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              redact(
                `审查Agent退出${code}: ${failedOutput(output)}\n${diagnostic}`,
                [context.key],
              ),
            ),
          );
        else resolve(output);
      });
      child.stdin.end(prompt);
    });
    return reviewOutput(context.configuration.agent, output, [context.key]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
