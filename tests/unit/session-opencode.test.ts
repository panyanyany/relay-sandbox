import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeBridge } from "../../src/agents/sessions/opencode-bridge.js";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/docker/interactive.js", () => ({
  startInteractiveExec: execMock,
}));

describe("OpenCode 结构化请求", () => {
  it("结构化输入复用同一原生会话", async () => {
    const calls: string[] = [];
    const bridge = createOpenCodeBridge({
      nativeId: "ses_one",
      request: async (_method, path) => {
        calls.push(path);
        return {
          status: 200,
          body: {
            info: { id: "msg_a", finish: "stop" },
            parts: [{ type: "text", text: "回答" }],
          },
        };
      },
      emit: async () => {},
    });
    await bridge.submit("你好");
    expect(calls).toEqual(["/session/ses_one/message"]);
  });
});

// 用 stdio 假进程观察协议边界，不启动 Docker 或真实模型。
describe("OpenCode 结构化后台", () => {
  function fixture(existing?: { status: number; body: unknown }) {
    let exitService!: (code: number) => void;
    const paths: string[] = [];
    const launches: string[][] = [];
    const events: unknown[] = [];
    execMock.mockImplementation(
      async (_docker, options: { argv: string[] }) => {
        launches.push(options.argv);
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let finish!: (code: number) => void;
        const completion = new Promise<number>((resolve) => {
          finish = resolve;
        });
        if (options.argv.length === 3) {
          exitService = finish;
          stdin.on("finish", () => finish(0));
        }
        else {
          const path = options.argv[4]!;
          paths.push(path);
          const reply =
            path === "/global/health"
              ? { status: 200, body: {} }
              : path === "/session"
                ? { status: 200, body: { id: "ses_new" } }
                : path.endsWith("/message")
                  ? {
                      status: 200,
                      body: {
                        info: { id: "answer", finish: "stop" },
                        parts: [{ type: "text", text: "真实完成" }],
                      },
                    }
                  : (existing ?? { status: 200, body: { id: "ses_old" } });
          setImmediate(() => {
            stdout.end(JSON.stringify(reply));
            finish(0);
          });
        }
        return { stdin, stdout, stderr, completion, resize: async () => {} };
      },
    );
    return {
      exitService: (code: number) => exitService(code),
      paths,
      launches,
      events,
      options: {
        docker: {} as import("dockerode"),
        containerId: "synthetic",
        environment: {},
        bindNative: vi.fn(),
        emit: async (event: unknown) => {
          events.push(event);
        },
        controls: { fail: vi.fn() },
      },
    };
  }
  it("仅启动 serve，首建后同步完成请求", async () => {
    const { createOpenCodeDriver } =
      await import("../../src/agents/sessions/opencode-driver.js");
    const f = fixture();
    const driver = await createOpenCodeDriver(f.options);
    try {
      await driver.submit("你好");
      expect(f.paths).toEqual([
        "/global/health",
        "/session",
        "/session/ses_new/message",
      ]);
      expect(f.launches.filter((argv) => argv.length === 3)).toHaveLength(1);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            text: "真实完成",
            complete: true,
          }),
        }),
      );
    } finally {
      await driver.close();
    }
  });
  it("主动停止确认后容器退出不记故障，非主动退出仍上报", async () => {
    const { createOpenCodeDriver } =
      await import("../../src/agents/sessions/opencode-driver.js");
    for (const planned of [true, false]) {
      const f = fixture();
      const driver = await createOpenCodeDriver(f.options);
      if (planned) await driver.stop();
      f.exitService(137);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.options.controls.fail).toHaveBeenCalledTimes(planned ? 0 : 1);
      await driver.close();
    }
  });
  it("停止被拒后仍保留后端异常证据", async () => {
    const { createOpenCodeDriver } =
      await import("../../src/agents/sessions/opencode-driver.js");
    const f = fixture({ status: 500, body: {} });
    const driver = await createOpenCodeDriver(f.options);
    await expect(driver.stop()).rejects.toThrow("停止失败");
    f.exitService(137);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.options.controls.fail).toHaveBeenCalledTimes(1);
    await driver.close();
  });
  it("恢复核对原生身份，缺失或串号不新建", async () => {
    const { createOpenCodeDriver } =
      await import("../../src/agents/sessions/opencode-driver.js");
    for (const reply of [
      { status: 404, body: {} },
      { status: 200, body: { id: "ses_other" } },
    ]) {
      const f = fixture(reply);
      await expect(
        createOpenCodeDriver({ ...f.options, nativeId: "ses_old" }),
      ).rejects.toThrow("恢复");
      expect(f.paths).toEqual(["/global/health", "/session/ses_old"]);
    }
    const f = fixture();
    const driver = await createOpenCodeDriver({
      ...f.options,
      nativeId: "ses_old",
    });
    await driver.close();
    expect(f.options.bindNative).not.toHaveBeenCalled();
  });
});

// 完成标记和上游错误决定轮次结果，不能用 HTTP 200 冒充开发成功。
it("结构化轮次拒绝上游错误与缺失完成标记", async () => {
  for (const info of [{ error: { name: "ProviderError" } }, {}]) {
    const events: unknown[] = [];
    const bridge = createOpenCodeBridge({
      nativeId: "ses_one",
      request: async () => ({ status: 200, body: { info, parts: [] } }),
      emit: async (event) => {
        events.push(event);
      },
    });
    await expect(bridge.submit("hello")).rejects.toThrow(/轮次/);
    expect(events).toHaveLength(1);
  }
});
