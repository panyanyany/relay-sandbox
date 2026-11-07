import type Docker from "dockerode";
import { startInteractiveExec } from "../../docker/interactive.js";
import { createOpenCodeSkills } from "./opencode-skills.js";
import type { SessionEventInput } from "../../sessions/events.js";
import { createOpenCodeBridge, type OpenCodeReply } from "./opencode-bridge.js";

const requestProgram = String.raw`
const http=require('node:http');const [method,path,body]=process.argv.slice(1);const q=http.request({host:'127.0.0.1',port:4997,path,method,headers:{'content-type':'application/json'}},r=>{let data='';r.on('data',c=>{data+=c;if(data.length>4194304){q.destroy(new Error('响应超过预算'))}});r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body:data?JSON.parse(data):null})))});q.setTimeout(path==='/global/health'?2000:1800000,()=>q.destroy(new Error('OpenCode 请求超时')));q.on('error',e=>{console.error(e.message);process.exitCode=1});q.end(body);
`;
export interface OpenCodeDriverOptions {
  docker: Docker;
  containerId: string;
  environment: Readonly<Record<string, string>>;
  nativeId?: string;
  bindNative(id: string): Promise<unknown>;
  emit(event: SessionEventInput): Promise<unknown>;
  controls: {
    fail?(error: unknown): Promise<void>;
  };
}
// 仅通过 Docker exec 接入容器 loopback，不开放宿主端口或挂载控制 socket。
export async function createOpenCodeDriver(input: OpenCodeDriverOptions) {
  const env = { ...input.environment };
  const launch = (argv: string[]) =>
    startInteractiveExec(input.docker, {
      containerId: input.containerId,
      argv,
      env,
      tty: false,
    });
  const service = await launch([
    "node",
    "-e",
    "const {spawn}=require('node:child_process');const p=spawn('opencode',['serve','--hostname','127.0.0.1','--port','4997'],{stdio:['ignore','inherit','inherit']});process.stdin.resume();process.stdin.on('end',()=>p.kill('SIGTERM'));p.on('exit',code=>process.exit(code??1));p.on('error',e=>{console.error(e.message);process.exit(1)})",
  ]);
  service.stdout.resume();
  service.stderr.resume();
  let serviceError: unknown;
  let driverError: unknown;
  let closing = false;
  void service.completion
    .then(
      (code) => {
        serviceError = new Error(`OpenCode serve 已退出: ${code}`);
        if (!closing) return input.controls.fail?.(serviceError);
      },
      (error) => {
        serviceError = error;
        if (!closing) return input.controls.fail?.(error);
      },
    )
    .catch((error: unknown) => {
      driverError = error;
    });
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<OpenCodeReply> {
    if (serviceError) throw serviceError;
    if (driverError) throw driverError;
    const exec = await launch([
      "node",
      "-e",
      requestProgram,
      method,
      path,
      body === undefined ? "" : JSON.stringify(body),
    ]);
    let output = "";
    let diagnostic = "";
    exec.stdout.on("data", (chunk) => {
      output += chunk;
    });
    exec.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    if (await exec.completion)
      throw new Error(`OpenCode HTTP 桥失败: ${diagnostic}`);
    return JSON.parse(output) as OpenCodeReply;
  }
  try {
    const deadline = Date.now() + 90000;
    while (true) {
      try {
        if ((await request("GET", "/global/health")).status === 200) break;
      } catch (error) {
        if (Date.now() >= deadline || serviceError) throw error;
      }
      if (Date.now() >= deadline) throw new Error("OpenCode 启动超过 90 秒");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    let nativeId = input.nativeId;
    // 错误示范：容器健康就宣布恢复，或历史丢失时另建会话。
    if (nativeId) {
      const restored = await request(
        "GET",
        `/session/${encodeURIComponent(nativeId)}`,
      );
      if (
        restored.status !== 200 ||
        (restored.body as { id?: string } | null)?.id !== nativeId
      )
        throw new Error("OpenCode 恢复失败：原生会话不存在或身份不一致");
    }
    if (!nativeId) {
      const created = await request("POST", "/session", {});
      nativeId = (created.body as { id?: string }).id;
      if (created.status >= 400 || !nativeId)
        throw new Error("OpenCode 未返回原生会话标识");
      await input.bindNative(nativeId);
    }
    const bridge = createOpenCodeBridge({
      nativeId,
      request,
      emit: input.emit,
    });
    const skills = createOpenCodeSkills({
      readCapability: (path) => request("GET", path),
      submit: (prompt) => bridge.submit(prompt),
    });
    // 已获准的结构化请求直接使用 serve，不启动界面代理或第二份租约。
    return {
      nativeId,
      ...skills,
      submit: (prompt: string) => bridge.submit(prompt),
      readCapability: (path: "/skill" | "/command") => {
        if (path !== "/skill" && path !== "/command")
          throw new Error("OpenCode 未知只读能力路径");
        return request("GET", path);
      },
      async stop() {
        const reply = await request(
          "POST",
          `/session/${encodeURIComponent(nativeId)}/abort`,
        );
        if (reply.status >= 400)
          throw new Error(`OpenCode 停止失败: HTTP ${reply.status}`);
        // abort确认后，调用方将停止归属容器；其serve退出属于本次主动停机。
        // 错误示范：等close才标记，会把stopTask产生的137误记成后端故障。
        closing = true;
      },
      async close() {
        closing = true;
        service.stdin.end();
        await service.completion;
      },
    };
  } catch (error) {
    service.stdin.end();
    throw error;
  }
}
