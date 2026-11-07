import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type Docker from "dockerode";
import {
  startInteractiveExec,
  type InteractiveExec,
} from "../../docker/interactive.js";
import type { NativeSessionDriver } from "../../sessions/worker.js";
import type { ExecutableSessionRequest } from "../../sessions/requests.js";
import { checkClaudeReadiness } from "./claude-readiness.js";
import { createClaudeSkills } from "./claude-skills.js";
import { claudeLaunch, claudeMessage } from "./claude-code.js";

const wrapperScript = `const fs=require('node:fs'),cp=require('node:child_process');const p=cp.spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit',detached:true});fs.writeFileSync(process.argv[1],String(p.pid),{mode:384});p.on('error',e=>{console.error(e);process.exitCode=1});p.on('exit',(code,signal)=>{fs.rmSync(process.argv[1],{force:true});process.exitCode=code??(signal?1:0)});`;
// 统一输入只启动 print 协议；租约和首次请求持久化由外层负责。
export function createStructuredClaudeDriver(input: {
  docker: Docker;
  containerId: string;
  nativeId?: string;
  model: string;
  environment: Readonly<Record<string, string>>;
  bindNative(id: string): Promise<void>;
}) {
  const nativeId = input.nativeId ?? randomUUID();
  const pidFile = `/tmp/relay-claude-${randomUUID()}.pid`;
  let history = Boolean(input.nativeId);
  let active: InteractiveExec | undefined;
  let closed = false;
  let initialization: Readonly<Record<string, unknown>> | undefined;
  const launch = (argv: string[]) =>
    startInteractiveExec(input.docker, {
      containerId: input.containerId,
      argv,
      tty: false,
      env: { ...input.environment },
    });
  const skills = createClaudeSkills({ getInitialization: () => initialization });
  return {
    nativeId,
    async ready() {
      if (closed) throw new Error("Claude 开发已停止");
      if (active) throw new Error("Claude 会话忙碌");
      await checkClaudeReadiness({ launch, nativeId, resume: history, model: input.model });
    },
    async capabilities() {
      return skills.capabilities();
    },
    async listSkills() {
      return skills.list();
    },
    // 技能与消息共用结构化边界；不把不支持的技能降级为提示词。
    async execute(
      request: ExecutableSessionRequest,
      context: Parameters<NativeSessionDriver["submit"]>[1],
    ) {
      if (request.type === "skill") return skills.invoke(request);
      await this.submit(request.prompt, context);
    },
    // 仅读取已经收到的原生能力；发现操作不发送探测 prompt。
    getInitialization() {
      return initialization;
    },
    async submit(
      prompt: string,
      context: Parameters<NativeSessionDriver["submit"]>[1],
    ) {
      if (closed) throw new Error("Claude 开发已停止");
      if (active) throw new Error("Claude 会话忙碌");
      const resume = history;
      if (!history) {
        // 错误示范：先启动再绑定会让首次失败丢失身份；失败后也不换 ID 重放。
        await input.bindNative(nativeId);
        history = true;
      }
      // worker租约对应已保存的一次请求；稳定消息ID让跨入口重放沿用同一用户记录。
      await context.emit({
        type: "message",
        payload: {
          role: "user", text: prompt, complete: true,
          messageId: context.lease.token,
        },
      });
      const exec = await launch([
        "node",
        "-e",
        wrapperScript,
        pidFile,
        ...claudeLaunch({
          nativeId,
          model: input.model,
          settings: "{}",
          structured: true,
          resume,
          prompt,
        }),
      ]);
      active = exec;
      exec.stderr.resume();
      let completed = false;
      let failure: unknown;
      try {
        // 完整消息按真实协议输出；不从 ANSI 屏幕合成增量或依赖 hook。
        for await (const line of createInterface({ input: exec.stdout })) {
          try {
            const value: unknown = JSON.parse(line);
            if (
              value &&
              typeof value === "object" &&
              "type" in value &&
              value.type === "system" &&
              "subtype" in value &&
              value.subtype === "init"
            )
              initialization = Object.freeze({ ...value });
            const message = claudeMessage(value);
            for (const event of message.events) await context.emit(event);
            completed ||= message.completed;
          } catch (error) {
            failure ??= error;
          }
        }
        const code = await exec.completion;
        if (failure) throw failure;
        if (code !== 0 || !completed)
          throw new Error(`Claude 轮次未完成，退出码 ${code}`);
      } finally {
        if (active === exec) active = undefined;
      }
    },
    async stop() {
      closed = true;
      if (!active) return;
      const exec = active;
      const stop = await launch([
        "node",
        "-e",
        "const fs=require('node:fs');process.kill(-Number(fs.readFileSync(process.argv[1],'utf8')),'SIGTERM')",
        pidFile,
      ]);
      stop.stdout.resume();
      stop.stderr.resume();
      if ((await stop.completion) !== 0)
        throw new Error("Claude 结构化进程停止失败");
      await exec.completion;
    },
    async close() {
      await this.stop();
    },
  };
}
