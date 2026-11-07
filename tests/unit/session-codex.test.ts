import { PassThrough } from "node:stream";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCodexGateway } from "../../src/agents/sessions/codex-gateway.js";

// 已有租约的网页提交不能再取得原生锁；delta 与退出证据独立于屏幕。
test("结构化提交沿用租约并投影 delta，137 明确失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-driver-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: Array<{ method: string; params?: { threadId?: string } }> =
    [];
  const events: unknown[] = [];
  let terminate!: (code: number) => void;
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    if (request.id !== undefined)
      stdout.write(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "initialize"
              ? {}
              : { thread: { id: "native-two" }, turn: { id: "turn-two" } },
        }) + "\n",
      );
  });
  const gateway = await createCodexGateway({
    upstream: {
      stdin,
      stdout,
      stderr: new PassThrough(),
      completion: new Promise<number>((resolve) => {
        terminate = resolve;
      }),
      resize: async () => {},
    },

    nativeSessionId: "native-two",
    bindNativeSession: async () => {},
    emit: async (event) => {
      events.push(event);
    },
  });
  try {
    const first = gateway.submit("hello", {
      lease: { token: "owned" } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdout.write(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "answer", delta: "hi" },
      }) + "\n",
    );
    stdout.write(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "native-two",
          turn: { id: "turn-two", status: "completed" },
        },
      }) + "\n",
    );
    await first;
    expect(events).toContainEqual({
      type: "message",
      payload: {
        role: "assistant",
        text: "hi",
        complete: false,
        messageId: "answer",
      },
    });
    expect(requests.some((request) => request.method === "thread/resume")).toBe(
      true,
    );
    expect(requests.some((request) => request.method === "thread/start")).toBe(
      false,
    );
    expect(
      requests.find((request) => request.method === "turn/start")?.params
        ?.threadId,
    ).toBe("native-two");
    const second = gateway.submit("next", {
      lease: { token: "owned-again" } as never,
    });
    const rejected = expect(second).rejects.toThrow("137");
    await new Promise((resolve) => setTimeout(resolve, 10));
    terminate(137);
    await rejected;
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// 空闲退出没有 active lease，仍必须通知统一 worker 生命周期。
test("空闲 app-server 退出传播后台故障", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-death-"));
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  let exit!: (code: number) => void;
  let failure: unknown;
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    if (request.id !== undefined)
      stdout.write(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "initialize" ? {} : { thread: { id: "native" } },
        }) + "\n",
      );
  });
  const gateway = await createCodexGateway({
    upstream: {
      stdin,
      stdout,
      stderr: new PassThrough(),
      completion: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      resize: async () => {},
    },

    bindNativeSession: async () => {},
    emit: async () => {},

    fail: async (error) => {
      failure = error;
    },
  });
  try {
    exit(137);
    await expect.poll(() => String(failure)).toContain("137");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// 统一输入不打开原生renderer，也不能以空历史快照冒充读取结果。
test("纯结构化创建、受控读取及真实轮次结束", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-structured-"));
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const calls: Array<{ method: string; params?: unknown }> = [];
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    calls.push(request);
    if (request.id === undefined) return;
    const response =
      request.method === "thread/read"
        ? { error: { code: -1, message: "no rollout found" } }
        : {
            result:
              request.method === "thread/start"
                ? { thread: { id: "structured", turns: [] } }
                : { turn: { id: "real-turn" } },
          };
    stdout.write(JSON.stringify({ id: request.id, ...response }) + "\n");
  });
  const path = join(directory, "absent.sock");
  const gateway = await createCodexGateway({
    upstream: {
      stdin,
      stdout,
      stderr: new PassThrough(),
      completion: new Promise<number>(() => {}),
      resize: async () => {},
    },

    bindNativeSession: async (id) => expect(id).toBe("structured"),
    emit: async () => {},
  });
  try {
    await expect(access(path)).rejects.toThrow();
    expect(gateway).not.toHaveProperty("nativeLaunch");
    await expect(
      gateway.read("thread/read", { threadId: "structured" }),
    ).rejects.toThrow("no rollout found");
    await expect(gateway.read("turn/start", {})).rejects.toThrow("只读");
    await expect(
      gateway.read("thread/read", { threadId: "other" }),
    ).rejects.toThrow("其他");
    let settled = false;
    const turn = gateway.submitInputs([{ type: "text", text: "hello" }], {
      lease: { token: "owned" } as never,
    });
    void turn.then(
      () => {
        settled = true;
      },
      () => {},
    );
    await expect
      .poll(() => calls.some((call) => call.method === "turn/start"))
      .toBe(true);
    const complete = (id: string, status = "completed") =>
      stdout.write(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "structured",
            turn: { id, status, error: { message: "real failure" } },
          },
        }) + "\n",
      );
    complete("stale-turn");
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const rejected = expect(turn).rejects.toThrow("real failure");
    complete("real-turn", "failed");
    await rejected;
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(
      1,
    );
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// 错误示范：恢复失败后thread/start会静默丢失原生上下文，必须保留失败。
test("纯结构化恢复失败不另开线程", async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const calls: string[] = [];
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    calls.push(request.method);
    if (request.id !== undefined)
      stdout.write(
        JSON.stringify({
          id: request.id,
          ...(request.method === "thread/resume"
            ? { error: { code: -1, message: "missing native history" } }
            : { result: {} }),
        }) + "\n",
      );
  });
  await expect(
    createCodexGateway({
      upstream: {
        stdin,
        stdout,
        stderr: new PassThrough(),
        completion: new Promise<number>(() => {}),
        resize: async () => {},
      },

      nativeSessionId: "existing",
      bindNativeSession: async () => {
        throw new Error("不应绑定");
      },
      emit: async () => {},
    }),
  ).rejects.toThrow("missing native history");
  expect(calls).toEqual(["initialize", "initialized", "thread/resume"]);
  stdin.end();
  stdout.end();
});
