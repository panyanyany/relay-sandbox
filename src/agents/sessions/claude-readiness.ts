import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { InteractiveExec } from "../../docker/interactive.js";

// 专属包装器拥有子进程组；EOF 不是单纯断流，而是 TERM→KILL 后等待退出。
// 容器内独立超时还覆盖宿主失联，不能因清理探针而停止整个项目容器。
const readinessWrapper = `const cp=require('node:child_process');
const timeout=Number(process.argv[1]);
const child=cp.spawn('claude',process.argv.slice(2),{stdio:['pipe','pipe','pipe'],detached:true});
let stopping=false,kill,force;
function terminate(){if(stopping)return;stopping=true;try{process.kill(-child.pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')process.stderr.write(String(e))}kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')process.stderr.write(String(e))}},500);force=setTimeout(()=>process.exit(124),1500)}
const deadline=setTimeout(terminate,timeout);
process.stdin.pipe(child.stdin,{end:false});process.stdin.on('end',terminate);process.stdin.on('error',terminate);
child.stdin.on('error',()=>{});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('error',e=>{process.stderr.write(String(e));process.exitCode=1;clearTimeout(deadline)});
child.on('close',code=>{clearTimeout(deadline);clearTimeout(kill);clearTimeout(force);process.stdin.unpipe();process.stdin.destroy();process.exitCode=stopping?0:(code??1)});`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

// 无用户请求的 SDK 初始化仅确认指定历史可读；不创建替代 ID 或重放开发请求。
export async function checkClaudeReadiness(input: {
  launch(argv: string[]): Promise<InteractiveExec>;
  nativeId: string;
  resume: boolean;
  model: string;
  timeoutMilliseconds?: number;
}): Promise<void> {
  const timeout = input.timeoutMilliseconds ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new Error("Claude 就绪超时必须为 1–60000 毫秒");
  const exec = await input.launch([
    "node", "-e", readinessWrapper, String(timeout), "-p",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    input.resume ? "--resume" : "--session-id", input.nativeId,
    "--model", input.model, "--settings", "{}", "--setting-sources", "",
    "--strict-mcp-config", "--dangerously-skip-permissions",
  ]);
  exec.stderr.resume();
  const lines = createInterface({ input: exec.stdout });
  const requestId = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Claude 就绪控制初始化超时")), timeout);
      lines.on("line", (line) => {
        try {
          const message = record(JSON.parse(line));
          if (message?.type === "result")
            throw new Error(`Claude 就绪失败：${JSON.stringify(message.errors ?? message.subtype)}`);
          if (message?.type !== "control_response") return;
          const response = record(message.response);
          if (response?.request_id !== requestId) return;
          // 错误示范：任意 success 或 system/init 都不能证明目标历史已经空闲可用。
          if (response.subtype !== "success" || record(response.response)?.session_state !== "idle")
            throw new Error(`Claude 就绪控制应答无效：${JSON.stringify(response)}`);
          resolve();
        } catch (error) { reject(error); }
      });
      void exec.completion.then(
        (code) => reject(new Error(`Claude 就绪进程提前退出：${code}`)), reject,
      );
      exec.stdin.write(JSON.stringify({
        type: "control_request", request_id: requestId, request: { subtype: "initialize" },
      }) + "\n");
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    lines.close();
    exec.stdout.resume();
    exec.stdin.end();
    try {
      const code = await Promise.race([
        exec.completion,
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error("Claude 就绪专属进程清理超时")), 3000);
        }),
      ]);
      if (code !== 0) throw new Error(`Claude 就绪专属进程清理失败：${code}`);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Claude 就绪及清理失败") : error;
    } finally { clearTimeout(cleanupTimer); }
  }
  if (failure) throw failure;
}
