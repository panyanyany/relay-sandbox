import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClaudeReadiness } from "../../src/agents/sessions/claude-readiness.js";

// 合成 exec 只在 stdin 关闭后结束，验证就绪也必须收尾专属进程。
function fixture() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let finish!: (code: number) => void;
  const completion = new Promise<number>((resolve) => { finish = resolve; });
  stdin.on("end", () => { stdout.end(); finish(0); });
  let frame: { request_id: string; request: { subtype: string }; type: string };
  stdin.on("data", (chunk: Buffer) => { frame = JSON.parse(chunk.toString()); });
  const exec = { stdin, stdout, stderr, completion, resize: vi.fn(async () => {}) };
  const launch = vi.fn(async (_argv: string[]) => exec);
  return { exec, launch, finish, frame: () => frame!, ack(id?: string, state = "idle") {
    stdout.write(JSON.stringify({ type: "control_response", response: {
      request_id: id ?? frame!.request_id, subtype: "success", response: { session_state: state },
    } }) + "\n");
  } };
}
const options = { nativeId: "synthetic-id", resume: true, model: "fake", timeoutMilliseconds: 100 };
afterEach(() => vi.useRealTimers());

describe("Claude 无提示恢复就绪", () => {
  it("匹配控制应答才成功，不发送用户消息且正常收尾", async () => {
    const f = fixture();
    const ready = checkClaudeReadiness({ ...options, launch: f.launch });
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    expect(f.frame()).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
    f.ack(); await ready;
    expect(f.exec.stdin.writableEnded).toBe(true);
    const argv = f.launch.mock.calls[0]![0];
    expect(argv).toContain("--resume"); expect(argv).toContain("--input-format");
    expect(argv).not.toContain("--session-id");
    expect(JSON.stringify(f.frame())).not.toContain("prompt");
  });

  it("新上下文仅使用指定 session-id，不冒充恢复", async () => {
    const f = fixture();
    const ready = checkClaudeReadiness({ ...options, resume: false, launch: f.launch });
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    f.ack(); await ready;
    expect(f.launch.mock.calls[0]![0]).toContain("--session-id");
    expect(f.launch.mock.calls[0]![0]).not.toContain("--resume");
  });

  it("不接受其他请求的应答；超时仍清理", async () => {
    vi.useFakeTimers(); const f = fixture();
    const ready = checkClaudeReadiness({ ...options, launch: f.launch });
    const rejected = expect(ready).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(0); f.ack("other-request");
    await vi.advanceTimersByTimeAsync(101); await rejected;
    expect(f.exec.stdin.writableEnded).toBe(true);
  });

  it("历史不存在时保留协议错误，不创建新会话", async () => {
    const f = fixture(); const ready = checkClaudeReadiness({ ...options, launch: f.launch });
    const rejected = expect(ready).rejects.toThrow("No conversation found");
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    f.exec.stdout.write(JSON.stringify({ type: "result", is_error: true, errors: ["No conversation found"] }) + "\n");
    await rejected; expect(f.launch).toHaveBeenCalledOnce();
    expect(f.exec.stdin.writableEnded).toBe(true);
  });

  it("即使收到就绪，应答后的清理等待也有上限", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.exec.stdin.removeAllListeners("end");
    const ready = checkClaudeReadiness({ ...options, launch: f.launch });
    const rejected = expect(ready).rejects.toThrow("清理超时");
    await vi.advanceTimersByTimeAsync(0); f.ack();
    await vi.advanceTimersByTimeAsync(3001); await rejected;
    expect(f.exec.stdin.writableEnded).toBe(true);
    f.finish(0);
  });

  it("提前退出和非 idle 应答均失败", async () => {
    for (const mode of ["exit", "busy"]) {
      const f = fixture(); const ready = checkClaudeReadiness({ ...options, launch: f.launch });
      const rejected = expect(ready).rejects.toThrow();
      await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
      if (mode === "exit") f.finish(1); else f.ack(undefined, "busy");
      await rejected; expect(f.exec.stdin.writableEnded).toBe(true);
    }
  });
});
