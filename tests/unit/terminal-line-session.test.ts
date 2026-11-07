import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { runLineSession } from "../../src/terminal/line-session.js";
import { createLineOutput } from "../../src/terminal/line-output.js";
import { terminalLines } from "../../src/terminal/line-input.js";
import type { DevelopmentSession } from "../../src/sessions/schema.js";
const id = "d1ca1179-d239-4a3c-a62c-625440968ac0";
const session: DevelopmentSession = {
  version: 2,
  kind: "development",
  id,
  projectId: "demo",
  cwd: "/tmp/demo",
  agent: "codex",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
async function* lines(...values: string[]) {
  yield* values;
}
// 使用真实JSON控制层，避免逐行入口另建一套派发规则。
function fixture(input: AsyncIterable<string>) {
  const output: string[] = [];
  const request = vi.fn(async (_id: string, command: { type: string }) => {
    if (command.type === "execute") return { accepted: true };
    if (command.type === "events") return { cursor: 0, events: [] };
    return { state: { phase: "idle" } };
  });
  const activate = vi.fn(async (_request, saved) => {
    await saved(session);
    return session;
  });
  const dispatch = vi.fn(async () => undefined);
  const readOnly = vi.fn(async () => ({ supported: false }));
  return {
    output,
    request,
    activate,
    dispatch,
    readOnly,
    options: {
      input,
      write: (text: string) => {
        output.push(text);
      },
      request,
      activate,
      dispatch,
      readOnly,
      pollMilliseconds: 1,
    },
  };
}
it("空行和只读不创建会话，非法首命令可继续，多轮仅激活一次", async () => {
  const f = fixture(
    lines("", "!touch nope", "/help", "/skills", "hello", "again", "/exit"),
  );
  await runLineSession(f.options);
  expect(f.activate).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(
    f.request.mock.calls.filter(([, command]) => command.type === "execute"),
  ).toHaveLength(2);
  expect(f.readOnly).toHaveBeenCalledWith("skills");
  expect(f.output.join("")).toContain("不支持直接shell");
  expect(f.output.join("")).toContain("/help");
  expect(f.request.mock.calls.some(([, c]) => c.type === "stop")).toBe(false);
});
it("EOF仅结束观察，显式stop才停止，查询错误后仍可输入", async () => {
  const eof = fixture(lines("hello"));
  await runLineSession(eof.options);
  expect(eof.request.mock.calls.some(([, c]) => c.type === "stop")).toBe(false);
  const stopped = fixture(lines("/review", "hello", "/stop", "never"));
  await runLineSession(stopped.options);
  expect(stopped.output.join("")).toContain("尚无正式会话");
  expect(
    stopped.request.mock.calls.filter(([, c]) => c.type === "execute"),
  ).toHaveLength(1);
  expect(
    stopped.request.mock.calls.filter(([, c]) => c.type === "stop"),
  ).toHaveLength(1);
});
it("原始字节按行读取且中止不再等待输入", async () => {
  const controller = new AbortController();
  const input = new Readable({ read() {} });
  const iterator = terminalLines(input, controller.signal)[
    Symbol.asyncIterator
  ]();
  input.push("first\nsecond\n");
  expect(await iterator.next()).toEqual({ done: false, value: "first" });
  controller.abort();
  await iterator.return?.();
  input.destroy();
});
it("真实delta只输出一次，完整消息不伪流式，并清除终端控制字符", () => {
  const chunks: string[] = [];
  const output = createLineOutput((value) => {
    chunks.push(value);
  });
  const envelope = {
    version: 1 as const,
    sessionId: id,
    timestamp: new Date().toISOString(),
  };
  let cursor = 0;
  const message = (text: string, complete: boolean) =>
    output({
      type: "relay.event",
      event: {
        ...envelope,
        cursor: ++cursor,
        type: "message",
        payload: { role: "assistant", messageId: "m", text, complete },
      },
    });
  message("hel", false);
  message("lo", false);
  message("hello", true);
  message("\u001b[2Jcomplete", true);
  output({
    type: "relay.event",
    event: {
      ...envelope,
      cursor: ++cursor,
      type: "tool",
      payload: { name: "shell", callId: "c", phase: "started" },
    },
  });
  output({
    type: "relay.event",
    event: {
      ...envelope,
      cursor: ++cursor,
      type: "state",
      payload: { state: "idle" },
    },
  });
  output({
    type: "relay.gap",
    sessionId: id,
    from: 1,
    to: 2,
    reason: "retention",
  });
  output({ type: "relay.error", message: "failure", phase: "prepare" });
  expect(chunks.join("")).toContain("hello\n");
  expect(chunks.join("").match(/hello/g)).toHaveLength(1);
  expect(chunks).toContain("complete\n");
  expect(chunks.join("")).not.toContain("\u001b");
  for (const text of ["shell", "idle", "缺口", "prepare", "failure"])
    expect(chunks.join("")).toContain(text);
});

it("只读入口与Ctrl-C退出均不激活也不停止后台", async () => {
  const readonly = fixture(lines("", "/skills", "/exit"));
  await runLineSession(readonly.options);
  expect(readonly.activate).not.toHaveBeenCalled();
  const controller = new AbortController();
  const interrupted = fixture({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
  controller.abort();
  await runLineSession({ ...interrupted.options, signal: controller.signal });
  expect(interrupted.activate).not.toHaveBeenCalled();
  expect(interrupted.request).not.toHaveBeenCalled();
});

it("恢复入口沿用指定身份，只读状态不触发首次激活", async () => {
  const f = fixture(lines("/status", "/exit"));
  const ensureSession = vi.fn(async ({ sessionId, onSession }) => {
    expect(sessionId).toBe(id);
    await onSession(session);
    return session;
  });
  await runLineSession({ ...f.options, sessionId: id, ensureSession });
  expect(ensureSession).toHaveBeenCalledTimes(1);
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledWith(id);
  expect(
    f.request.mock.calls.some(
      ([actualId, c]) => actualId === id && c.type === "status",
    ),
  ).toBe(true);
  expect(f.output.join("")).toContain(id);
  expect(f.readOnly).not.toHaveBeenCalled();
});
