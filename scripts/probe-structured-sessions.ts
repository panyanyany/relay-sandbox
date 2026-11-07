import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createProbeProvider, delay, environment, start, stop, run, parse } from "./structured-probe-support.js";

// 错误示范：ID存在或退出0并不证明轮次完成，更不能证明恢复了原上下文。
export function classifyStructuredEvidence(input: {
  id?: string;
  resumedId?: string;
  completed: boolean;
  priorContext: boolean;
}) {
  return {
    transport: Boolean(input.id),
    completed: input.completed,
    recovery: Boolean(input.id && input.id === input.resumedId && input.completed && input.priorContext),
  };
}
// 同一个本机假接口提供Anthropic和Responses协议，不访问任何远程模型。
export async function probeStructuredSessions(
  record: (agent: string, result: unknown) => Promise<void> = async () => {},
) {
  const root = await mkdtemp(join(tmpdir(), "relay-structured-"));
  const { server, calls, state } = createProbeProvider();
  const processes: ChildProcessWithoutNullStreams[] = [];
  try {
    for (const name of ["home", "project", "codex", "claude"]) await mkdir(join(root, name));
    const skillDir = join(root, "project", ".agents", "skills", "u01-probe");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: u01-probe\ndescription: Synthetic local capability probe\n---\nReply with the synthetic marker U01_SKILL_MARKER.\n",
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("没有回环地址");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = environment(root);
    await writeFile(
      join(root, "codex", "config.toml"),
      `model="gpt-5.4"\nmodel_provider="probe"\n[model_providers.probe]\nname="probe"\nbase_url="${endpoint}/v1"\nwire_api="responses"\nexperimental_bearer_token="fake-key"\n`,
    );
    let seq = 0;
    let notifications: Array<{ method: string; params: { turn: { id: string } } }> = [];
    const codex = () => {
      const child = start("codex", ["app-server", "--listen", "stdio://"], root, env);
      processes.push(child);
      child.stderr.resume();
      const pending = new Map<
        number,
        { resolve(value: { thread: { id: string }; turn: { id: string } }): void; reject(error: Error): void }
      >();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const m = JSON.parse(line);
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else notifications.push(m);
      });
      return {
        child,
        rpc: (method: string, params: unknown) =>
          new Promise<{ thread: { id: string }; turn: { id: string } }>((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(Error(`Codex RPC超时: ${method}`));
            }, 20000);
            timer.unref();
            const entry = pending.get(id)!;
            pending.set(id, {
              resolve(value) {
                clearTimeout(timer);
                entry.resolve(value);
              },
              reject(error) {
                clearTimeout(timer);
                entry.reject(error);
              },
            });
            child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
          }),
      };
    };
    const initialize = async (app: ReturnType<typeof codex>) => {
      await app.rpc("initialize", {
        clientInfo: { name: "relay-probe", version: "1" },
        capabilities: { experimentalApi: true },
      });
      app.child.stdin.write('{"method":"initialized"}\n');
    };
    const turn = async (app: ReturnType<typeof codex>, id: string, text: string, skillPath?: string) => {
      const r = await app.rpc("turn/start", {
        threadId: id,
        input: [{ type: "text", text }, ...(skillPath ? [{ type: "skill", name: "u01-probe", path: skillPath }] : [])],
        approvalPolicy: "never",
      });
      for (let i = 0; i < 200; i++) {
        if (notifications.some((n) => n.method === "turn/completed" && n.params.turn.id === r.turn.id)) return true;
        await delay(50);
      }
      return false;
    };
    let app = codex();
    await initialize(app);
    const first = await app.rpc("thread/start", {
      cwd: join(root, "project"),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const codexFirst = await turn(app, first.thread.id, "u01-codex-nonce");
    const skills = await app.rpc("skills/list", { cwds: [join(root, "project")] });
    await stop(app.child);
    notifications = [];
    app = codex();
    await initialize(app);
    const resumed = await app.rpc("thread/resume", {
      threadId: first.thread.id,
      cwd: join(root, "project"),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const codexSecond = await turn(app, resumed.thread.id, "second synthetic request");
    const skillCompleted = await turn(app, resumed.thread.id, "synthetic skill request", join(skillDir, "SKILL.md"));
    const skillMarkerInRequest = JSON.stringify(calls.at(-1)?.body).includes("U01_SKILL_MARKER");
    await stop(app.child);
    const codexResult = {
      id: first.thread.id,
      resumedId: resumed.thread.id,
      completed: codexFirst && codexSecond,
      priorContext: JSON.stringify(calls.at(-1)?.body).includes("u01-codex-nonce"),
      skillsList: skills,
      nativeSkillInvocation: { skillCompleted, skillMarkerInRequest, inputType: "skill" },
    };
    await record("codex", codexResult);
    const cenv = { ...env, ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: endpoint };
    const cid = randomUUID();
    const base = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--model",
      "fake",
    ];
    state.rejectClaude = true;
    const failed = await run("claude", ["-p", "u01-claude-failed-nonce", "--session-id", cid, ...base], root, cenv);
    state.rejectClaude = false;
    const retry = await run("claude", ["-p", "u01-claude-recover-nonce", "--resume", cid, ...base], root, cenv);
    const third = await run("claude", ["-p", "synthetic continuation", "--resume", cid, ...base], root, cenv);
    const cevents = parse(third.stdout);
    const init = parse(retry.stdout).find((e) => e.type === "system" && e.subtype === "init");
    const claudeResult = {
      id: cid,
      resumedId: cevents.find((e) => e.type === "result")?.session_id,
      firstFailure: {
        code: failed.code,
        events: parse(failed.stdout).map((e) => ({ type: e.type, subtype: e.subtype, is_error: e.is_error })),
      },
      retryCode: retry.code,
      completed: cevents.some((e) => e.type === "result" && e.is_error === false),
      priorContext: JSON.stringify(calls.at(-1)?.body).includes("u01-claude-recover-nonce"),
      skills: init?.skills,
      slashCommands: init?.slash_commands,
      nativeSkillInvocation: "no_dedicated_structured_invocation_verified",
    };
    await record("claude", claudeResult);
    const ocenv = {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { openai: { options: { baseURL: endpoint + "/v1", apiKey: "fake-key" } } },
        disabled_providers: ["opencode"],
      }),
    };
    const portServer = createServer();
    await new Promise<void>((done) => portServer.listen(0, "127.0.0.1", done));
    const addr = portServer.address();
    if (!addr || typeof addr === "string") throw Error("端口分配失败");
    const port = addr.port;
    await new Promise<void>((done) => portServer.close(() => done()));
    const oc = start("opencode", ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], root, ocenv);
    processes.push(oc);
    oc.stdout.resume();
    oc.stderr.resume();
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...(body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        signal: AbortSignal.timeout(20000),
      });
      return {
        status: response.status,
        body: (await response.json()) as { id: string; info?: { error?: unknown; finish?: string } },
      };
    };
    for (let i = 0; ; i++) {
      try {
        await request("/global/health");
        break;
      } catch (error) {
        if (i > 100) throw error;
        await delay(100);
      }
    }
    const osession = await request("/session", {});
    const oid = osession.body.id;
    const send = (text: string) =>
      request(`/session/${oid}/message`, {
        model: { providerID: "openai", modelID: "gpt-4.1" },
        parts: [{ type: "text", text }],
      });
    const o1 = await send("u01-opencode-nonce");
    await stop(oc);
    const restarted = start(
      "opencode",
      ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
      root,
      ocenv,
    );
    processes.push(restarted);
    restarted.stdout.resume();
    restarted.stderr.resume();
    for (let i = 0; ; i++) {
      try {
        await request("/global/health");
        break;
      } catch (error) {
        if (i > 100) throw error;
        await delay(100);
      }
    }
    const o2 = await send("synthetic second");
    const oskills = await request("/skill");
    const commands = await request("/command");
    const ometa = await request(`/session/${oid}`);
    const opencodeResult = {
      id: oid,
      resumedId: ometa.body.id,
      completed: o1.status === 200 && o2.status === 200 && !o2.body.info?.error,
      priorContext: JSON.stringify(calls.at(-1)?.body).includes("u01-opencode-nonce"),
      finish: o2.body.info?.finish,
      skillsStatus: oskills.status,
      skills: oskills.body,
      commandsStatus: commands.status,
      commands: commands.body,
      nativeSkillInvocation: "skill_tool_not_executed",
    };
    await record("opencode", opencodeResult);
    return {
      scope: "real_installed_cli_local_fake_provider_no_remote_model",
      codex: codexResult,
      claude: claudeResult,
      opencode: opencodeResult,
      requests: calls.map((c) => ({ path: c.path })),
      cleanup: "finally_stops_owned_processes_and_removes_temp_root",
    };
  } finally {
    for (const child of processes) await stop(child);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = process.argv[2];
  console.log(
    JSON.stringify(
      await probeStructuredSessions(async (agent, result) => {
        if (evidence) await writeFile(join(evidence, agent + ".json"), JSON.stringify(result, null, 2));
      }),
      null,
      2,
    ),
  );
}
