import { describe, expect, it } from "vitest";
import type { JsonSessionOutput } from "../../src/sessions/json-protocol.js";
import { runJsonSession } from "../../src/sessions/json-command.js";
const id = "00000000-0000-4000-8000-000000000001";
const session = {
  version: 2 as const,
  kind: "development" as const,
  id,
  cwd: "/project",
  projectId: "p",
  agent: "codex" as const,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
};
async function* input(...lines: string[]) {
  yield* lines;
}
describe("JSONL 统一会话", () => {
  it("准备前早期输出外部ID；连续输入busy失败不排队", async () => {
    const output: JsonSessionOutput[] = [];
    let submissions = 0;
    await runJsonSession({
      input: input('{"prompt":"one"}', '{"prompt":"two"}'),
      write: (event) => {
        output.push(event);
      },
      ensureSession: async ({ onSession }) => {
        await onSession(session);
        expect(output[0]!.type).toBe("relay.session");
        return session;
      },
      dispatch: async () => {},
      request: async (_id, cmd) => {
        if (cmd.type === "submit") {
          if (++submissions === 2) throw new Error("busy");
          return { accepted: true };
        }
        return { cursor: 0, events: [] };
      },
      followUntilIdle: false,
    });
    expect(submissions).toBe(2);
    expect(output.filter((e) => e.type === "relay.session")).toHaveLength(1);
    expect(
      output.some((e) => e.type === "relay.error" && e.message === "busy"),
    ).toBe(true);
  });
  it("重放真实事件与gap，保留delta和cursor；拒绝旧宿主会话", async () => {
    const output: JsonSessionOutput[] = [];
    await runJsonSession({
      input: input('{"prompt":"one"}'),
      write: (event) => {
        output.push(event);
      },
      ensureSession: async () => session,
      dispatch: async () => {},
      request: async (_id, cmd) =>
        cmd.type === "submit"
          ? { accepted: true }
          : {
              cursor: 3,
              gap: { from: 1, to: 2, reason: "retention" },
              events: [
                {
                  version: 1,
                  sessionId: id,
                  cursor: 3,
                  timestamp: session.createdAt,
                  type: "message",
                  payload: {
                    role: "assistant",
                    text: "真实增量",
                    complete: false,
                  },
                },
              ],
            },
      followUntilIdle: false,
    });
    expect(output.some((e) => e.type === "relay.gap")).toBe(true);
    expect(output.find((e) => e.type === "relay.event")).toMatchObject({
      event: { payload: { complete: false } },
    });
    await expect(
      runJsonSession({
        input: input('{"prompt":"one"}'),
        write: () => {},
        ensureSession: async () => ({ ...session, version: 1 }) as never,
        dispatch: async () => {},
        request: async () => ({}),
      }),
    ).rejects.toThrow();
  });
});

it("EOF等待已接受轮次完成；断开只结束观察，不发送stop", async () => {
  const output: unknown[] = [];
  const commands: string[] = [];
  let statuses = 0;
  const result = await runJsonSession({
    input: input('{"prompt":"one"}'),
    write: (event) => {
      output.push(event);
    },
    ensureSession: async () => session,
    dispatch: async () => {},
    request: async (_id, cmd) => {
      commands.push(cmd.type);
      if (cmd.type === "submit") return { accepted: true };
      if (cmd.type === "status")
        return { state: { phase: ++statuses > 1 ? "idle" : "busy" } };
      return { cursor: 0, events: [] };
    },
    pollMilliseconds: 1,
  });
  expect(result.sessionId).toBe(id);
  expect(statuses).toBe(2);
  expect(commands).not.toContain("stop");
  const controller = new AbortController();
  await runJsonSession({
    input: input('{"prompt":"two"}'),
    signal: controller.signal,
    write: (event) => {
      if (event.type === "relay.accepted") controller.abort();
    },
    ensureSession: async () => session,
    dispatch: async () => {},
    request: async (_id, cmd) => {
      commands.push(cmd.type);
      return cmd.type === "submit"
        ? { accepted: true }
        : cmd.type === "status"
          ? { state: { phase: "busy" } }
          : { cursor: 0, events: [] };
    },
  });
  expect(commands).not.toContain("stop");
});

it("只读查询不创建身份；有效请求保存后才派发", async () => {
  const output: JsonSessionOutput[] = [];
  let saved = false;
  let activated = 0;
  await runJsonSession({
    input: input(
      '{"command":"skills"}',
      '{"request":{"type":"message","prompt":"go"}}',
    ),
    write: (event) => {
      output.push(event);
    },
    activate: async (_request, onSaved) => {
      activated++;
      saved = true;
      await onSaved(session);
      return session;
    },
    readOnly: async () => ({ supported: false }),
    dispatch: async () => {
      expect(saved).toBe(true);
      expect(output.some((e) => e.type === "relay.session")).toBe(true);
    },
    request: async (_id, command) =>
      command.type === "execute"
        ? { accepted: true }
        : { cursor: 0, events: [] },
    followUntilIdle: false,
  });
  expect(activated).toBe(1);
  expect(output[0]).toMatchObject({
    type: "relay.readonly",
    command: "skills",
  });
});
it("保存失败不派发；初始化失败仍先公布可靠身份", async () => {
  for (const failSave of [true, false]) {
    const output: JsonSessionOutput[] = [];
    let dispatched = 0;
    await expect(
      runJsonSession({
        input: input('{"prompt":"go"}'),
        write: (event) => {
          output.push(event);
        },
        activate: async (_request, onSaved) => {
          if (failSave) throw new Error("write failed");
          await onSaved(session);
          return session;
        },
        dispatch: async () => {
          dispatched++;
          throw new Error("prepare failed");
        },
        request: async () => {
          throw new Error("不应执行");
        },
        followUntilIdle: false,
      }),
    ).rejects.toThrow(failSave ? "write failed" : "prepare failed");
    expect(dispatched).toBe(failSave ? 0 : 1);
    expect(output.some((e) => e.type === "relay.session")).toBe(!failSave);
    expect(output.at(-1)).toMatchObject({ type: "relay.error" });
  }
});

it("正式身份输出断开仍执行已保存请求一次", async () => {
  let calls = 0;
  await expect(
    runJsonSession({
      input: input('{"prompt":"go"}'),
      write: () => {
        throw new Error("output closed");
      },
      activate: async (_request, onSaved) => {
        await onSaved(session);
        return session;
      },
      dispatch: async () => {},
      request: async (_id, command) => {
        if (command.type === "execute") calls++;
        return { accepted: true };
      },
    }),
  ).rejects.toThrow("output closed");
  expect(calls).toBe(1);
});

it("游标只向前重放，后续轮询不重复投影", async () => {
  const output: JsonSessionOutput[] = [];
  const cursors: number[] = [];
  let statuses = 0;
  await runJsonSession({
    input: input('{"prompt":"go","after":2}'),
    write: (event) => {
      output.push(event);
    },
    ensureSession: async () => session,
    dispatch: async () => {},
    pollMilliseconds: 1,
    request: async (_id, command) => {
      if (command.type === "submit") return { accepted: true };
      if (command.type === "status")
        return { state: { phase: ++statuses > 1 ? "idle" : "busy" } };
      if (command.type !== "events") throw new Error("unexpected command");
      cursors.push(command.after ?? 0);
      return {
        cursor: 3,
        events:
          command.after === 2
            ? [
                {
                  version: 1,
                  sessionId: id,
                  cursor: 3,
                  timestamp: session.createdAt,
                  type: "message",
                  payload: {
                    role: "assistant",
                    text: "delta",
                    complete: false,
                  },
                },
              ]
            : [],
      };
    },
  });
  expect(cursors).toEqual([2, 3]);
  expect(output.filter((event) => event.type === "relay.event")).toHaveLength(
    1,
  );
});

it("观察失败输出阶段错误；显式停止成功不再访问已关闭后台", async () => {
  for (const stop of [false, true]) {
    const output: JsonSessionOutput[] = [];
    const operation = runJsonSession({
      input: input(
        JSON.stringify(
          stop ? { command: "stop", sessionId: id } : { prompt: "go" },
        ),
      ),
      write: (event) => {
        output.push(event);
      },
      ensureSession: async () => session,
      dispatch: async () => {},
      request: async (_id, command) => {
        if (command.type === "stop") return { stopped: true };
        if (command.type === "submit") return { accepted: true };
        throw new Error("socket closed");
      },
    });
    if (stop) {
      await operation;
      expect(output.at(-1)).toMatchObject({
        type: "relay.readonly",
        result: { stopped: true },
      });
    } else {
      await expect(operation).rejects.toThrow("socket closed");
      expect(output.at(-1)).toMatchObject({
        type: "relay.error",
        phase: "observe",
      });
    }
  }
});

// 客户端只放弃等待；请求已经由后台接受，不追加 stop。
it.each([true, false])(
  "审查等待取消正常退出，审查为首条输入=%s",
  async (firstReview) => {
    const abort = new AbortController();
    const output: JsonSessionOutput[] = [];
    const commands: string[] = [];
    await runJsonSession({
      input: input(
        ...(firstReview ? [] : ['{"command":"help"}']),
        JSON.stringify({ sessionId: id, command: "review" }),
      ),
      write: (event) => {
        output.push(event);
      },
      ensureSession: async () => session,
      dispatch: async () => {},
      signal: abort.signal,
      request: async (_id, command) => {
        commands.push(command.type);
        if (command.type === "review") {
          abort.abort();
          throw new DOMException("等待已取消", "AbortError");
        }
        return { cursor: 0, events: [] };
      },
    });
    expect(commands).toContain("review");
    expect(commands).not.toContain("stop");
    expect(output.some((event) => event.type === "relay.error")).toBe(false);
  },
);
