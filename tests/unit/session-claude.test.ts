import { describe, expect, it, vi } from "vitest";
import {
  claudeLaunch,
  claudeMessage,
} from "../../src/agents/sessions/claude-code.js";
import type { SessionOperationLease } from "../../src/sessions/operation.js";
const lease: SessionOperationLease = {
  token: "00000000-0000-4000-8000-000000000001",
  kind: "development",
  pid: 1,
  identity: "test",
  createdAt: new Date().toISOString(),
};
describe("Claude 启动与消息解析", () => {
  it("hook 阻止不误报成功，续接使用同一个原生标识", () => {
    expect(() =>
      claudeMessage({
        type: "result",
        is_error: false,
        prevent_continuation: true,
      }),
    ).toThrow();
    expect(
      claudeLaunch({
        nativeId: "same",
        model: "model",
        settings: "{}",
        structured: true,
        resume: true,
        prompt: "hello",
      }),
    ).toContain("same");
  });
});

// 用本地子进程替代 Docker 传输，保留结构化驱动的真实 stdio 往返。
const execution = vi.hoisted(() => ({
  argv: [] as string[][],
  children: [] as import("node:child_process").ChildProcess[],
  environments: [] as Record<string, string>[],
}));
vi.mock("../../src/docker/interactive.js", async () => {
  const { spawn } = await import("node:child_process");
  return {
    startInteractiveExec: async (
      _docker: unknown,
      input: { argv: string[]; env: Record<string, string> },
    ) => {
      execution.argv.push(input.argv);
      execution.environments.push(input.env);
      const child = spawn(input.argv[0]!, input.argv.slice(1), {
        env: input.env,
        stdio: "pipe",
      });
      execution.children.push(child);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        completion: new Promise<number>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code) => resolve(code ?? 1));
        }),
        resize: async () => {},
      };
    },
  };
});

it("结构化 Claude 不启动 PTY/hook，绑定先于执行且失败后恢复同 ID", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createStructuredClaudeDriver } =
    await import("../../src/agents/sessions/claude-driver.js");
  const root = await mkdtemp(join(tmpdir(), "relay-claude-structured-"));
  await writeFile(
    join(root, "claude"),
    `#!/usr/bin/node
const a=process.argv.slice(2);if(JSON.parse(a[a.indexOf('--settings')+1]).hooks)process.exit(9);
if(a[a.indexOf('-p')+1]==='fail'){console.log(JSON.stringify({type:'result',is_error:true,num_turns:0}));process.exit(1)}
console.log(JSON.stringify({type:'user',message:{content:[{type:'text',text:a[a.indexOf('-p')+1]}]}}));console.log(JSON.stringify({type:'system',subtype:'init',skills:['native-skill']}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ACK'}]}}));console.log(JSON.stringify({type:'result',num_turns:1,is_error:false}));
`,
    { mode: 0o700 },
  );
  const start = execution.argv.length;
  const emit = vi.fn(async (_event: import("../../src/sessions/events.js").SessionEventInput) => {});
  const bindNative = vi.fn(async () => {
    expect(execution.argv).toHaveLength(start);
  });
  const driver = createStructuredClaudeDriver({
    docker: {} as import("dockerode"),
    containerId: "synthetic",
    model: "fake",
    environment: { PATH: root + ":/usr/bin:/bin" },
    bindNative,
  });
  try {
    expect(execution.argv).toHaveLength(start);
    await expect(driver.submit("fail", { emit, lease })).rejects.toThrow(
      "失败",
    );
    await driver.submit("next", { emit, lease: { ...lease, token: "00000000-0000-4000-8000-000000000002" } });
    // 事件会被同一会话日志供网页重放；失败轮次也保留真实用户输入，不能缺失或重复。
    const users = emit.mock.calls.map(([event]) => event).filter((event) => event.type === "message" && event.payload.role === "user");
    expect(users).toEqual([
      { type: "message", payload: { role: "user", text: "fail", complete: true, messageId: lease.token } },
      { type: "message", payload: { role: "user", text: "next", complete: true, messageId: "00000000-0000-4000-8000-000000000002" } },
    ]);
    expect(driver.getInitialization()?.skills).toEqual(["native-skill"]);
    const launches = execution.argv.slice(start);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--session-id");
    expect(launches[1]).toContain("--resume");
    expect(
      launches.every(
        (argv) => argv.includes(driver.nativeId) && argv.includes("-p"),
      ),
    ).toBe(true);
    expect(bindNative).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "message",
      payload: { role: "assistant", text: "ACK", complete: true },
    });
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("Claude 原生工具开始事件如实输出，零轮次不能成功", () => {
  expect(
    claudeMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-1", name: "Read" }] },
    }).events,
  ).toEqual([
    {
      type: "tool",
      payload: { name: "Read", callId: "call-1", phase: "started" },
    },
  ]);
  expect(() =>
    claudeMessage({ type: "result", num_turns: 0, is_error: false }),
  ).toThrow("未执行");
});

it("Claude 身份保存失败时不执行任何命令", async () => {
  const { createStructuredClaudeDriver } =
    await import("../../src/agents/sessions/claude-driver.js");
  const start = execution.argv.length;
  const driver = createStructuredClaudeDriver({
    docker: {} as import("dockerode"),
    containerId: "synthetic",
    model: "fake",
    environment: {},
    bindNative: async () => {
      throw new Error("保存失败");
    },
  });
  await expect(
    driver.submit("never", { emit: async () => {}, lease }),
  ).rejects.toThrow("保存失败");
  expect(execution.argv).toHaveLength(start);
  await driver.close();
});
