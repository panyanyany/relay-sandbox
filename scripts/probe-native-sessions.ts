import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

type NativeEvent = Record<string, unknown>;

// 错误示范：Claude 的钩子拒绝仍可能返回 success 和退出码 0，必须交叉检查。
export function classifyClaudeProbe(
  events: NativeEvent[],
  hooks: NativeEvent[],
  modelRequests: number,
) {
  const submit = hooks.find(
    (event) => event.hook_event_name === "UserPromptSubmit",
  );
  return {
    blocked: Boolean(
      submit &&
      modelRequests === 0 &&
      events.some((event) => event.prevent_continuation === true),
    ),
    nativeId: typeof submit?.session_id === "string" ? submit.session_id : null,
    modelRequests,
  };
}

// 只继承定位可执行文件所需的 PATH，绝不向探针传入用户密钥、历史和配置。
function isolatedEnvironment(
  root: string,
  endpoint: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "config"),
    ANTHROPIC_API_KEY: "relay-probe-fake-key",
    ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

// 实际执行本机 Claude 的结构化入口；本地假服务只计数，不转发任何请求。
export async function probeClaudeGate(binary = "claude") {
  const root = await mkdtemp(join(tmpdir(), "relay-native-probe-"));
  let modelRequests = 0;
  const requestPaths: string[] = [];
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    if (request.url?.split("?")[0]?.endsWith("/messages")) modelRequests++;
    request.resume();
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          type: "probe_rejected",
          message: "gate must prevent this request",
        },
      }),
    );
  });
  try {
    await Promise.all([
      mkdir(join(root, "project")),
      mkdir(join(root, "home")),
    ]);
    const hook = join(root, "hook.mjs"),
      hookOutput = join(root, "hooks.jsonl");
    await writeFile(
      hook,
      `import{appendFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;appendFileSync(${JSON.stringify(hookOutput)},input+'\\n');process.exit(2);`,
    );
    // Node 路径和临时文件均由程序生成，使用单引号逐项转义，避免命令插值。
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const settings = join(root, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${quote(process.execPath)} ${quote(hook)}`,
                },
              ],
            },
          ],
        },
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("本地探针没有取得监听地址");
    const nativeId = randomUUID();
    const child = spawn(
      binary,
      [
        "-p",
        "synthetic gate probe",
        "--session-id",
        nativeId,
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        settings,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--model",
        "fake",
      ],
      {
        cwd: join(root, "project"),
        env: isolatedEnvironment(root, `http://127.0.0.1:${address.port}`),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
    } finally {
      clearTimeout(timer);
    }
    const parseLines = (text: string): NativeEvent[] =>
      text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as NativeEvent);
    const events = parseLines(output);
    const hooks = parseLines(await readFile(hookOutput, "utf8"));
    return {
      requestPaths,
      eventTypes: events.map((event) => ({
        type: event.type,
        subtype: event.subtype,
        prevent: event.prevent_continuation,
      })),
      exitCode,
      expectedNativeId: nativeId,
      ...classifyClaudeProbe(events, hooks, modelRequests),
      scope: "real_cli_structured_gate_only",
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}

// 显式调用才执行探针；导入单元测试不触发 CLI 或网络。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await probeClaudeGate(process.argv[2]);
  console.log(JSON.stringify(result));
  if (!result.blocked || result.nativeId !== result.expectedNativeId)
    process.exitCode = 1;
}
