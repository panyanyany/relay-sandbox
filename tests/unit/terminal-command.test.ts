import { expect, test, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  dispatch: vi.fn(),
  open: vi.fn(),
  startup: vi.fn(),
  activation: vi.fn(),
  ready: vi.fn(),
  json: vi.fn(),
  line: vi.fn(),
}));
vi.mock("../../src/sessions/worker-api.js", () => ({
  requestSessionWorker: mocks.request,
}));
vi.mock("../../src/sessions/dispatch.js", () => ({
  dispatchSessionWorker: mocks.dispatch,
}));
vi.mock("../../src/sessions/environment.js", () => ({
  openDevelopmentSession: mocks.open,
}));
vi.mock("../../src/sessions/startup-context.js", () => ({
  openStartupContext: mocks.startup,
}));
vi.mock("../../src/sessions/activation.js", () => ({
  createSessionActivation: mocks.activation,
}));
vi.mock("../../src/sessions/readiness.js", () => ({
  ensureSessionReady: mocks.ready,
}));
vi.mock("../../src/sessions/json-command.js", () => ({
  runJsonSession: mocks.json,
}));
vi.mock("../../src/terminal/line-session.js", () => ({
  runLineSession: mocks.line,
}));
import {
  connectSessionWorker,
  terminalChat,
} from "../../src/terminal/command.js";
import { closeStartup } from "../../src/sessions/startup-close.js";
import type { StartupContext } from "../../src/sessions/startup-context.js";
beforeEach(() => vi.resetAllMocks());
test("观察忙碌后台不启动第二实例，仅缺少连接才派发", async () => {
  mocks.request.mockResolvedValueOnce({ state: { phase: "busy" } });
  await connectSessionWorker("/private", "id");
  expect(mocks.dispatch).not.toHaveBeenCalled();
  mocks.request.mockRejectedValueOnce(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  await connectSessionWorker("/private", "id");
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  mocks.request.mockRejectedValueOnce(new Error("broken state"));
  await expect(connectSessionWorker("/private", "id")).rejects.toThrow(
    "broken state",
  );
});
test("宿主协调模型在准备前拒绝", async () => {
  await expect(
    terminalChat("/private", { model: "host-model" }),
  ).rejects.toThrow("项目冻结");
  expect(mocks.startup).not.toHaveBeenCalled();
});
test("默认逐行入口只读与空退出不创建正式会话，清理专属资源", async () => {
  const close = vi.fn();
  const startup = { resources: () => [{ close }] };
  mocks.startup.mockResolvedValue(startup);
  mocks.activation.mockReturnValue({ close: () => ({ cleanupStartup: true }) });
  mocks.line.mockImplementation(async (options) => {
    expect(await options.readOnly("status")).toEqual({ phase: "unstarted" });
    expect(await options.readOnly("skills")).toMatchObject({
      supported: false,
    });
  });
  await terminalChat("/private", {});
  expect(mocks.line).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
test("首次请求保存后才通告，已准入退出不清理后台", async () => {
  const close = vi.fn(),
    session = { id: "saved" };
  mocks.startup.mockResolvedValue({ resources: () => [{ close }] });
  mocks.activation.mockReturnValue({
    submit: async (
      request: unknown,
      callback: (value: unknown) => Promise<void>,
    ) => {
      expect(request).toEqual({ type: "message", prompt: "hello" });
      await callback(session);
      return { session };
    },
    close: () => ({ cleanupStartup: false }),
  });
  mocks.json.mockImplementation(async (options) => {
    const onSaved = vi.fn();
    expect(
      await options.activate({ type: "message", prompt: "hello" }, onSaved),
    ).toBe(session);
    expect(onSaved).toHaveBeenCalledWith(session);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  await terminalChat("/private", { prompt: "hello", json: true });
  expect(close).not.toHaveBeenCalled();
});
test("续接等待真实就绪且不创建启动上下文，缺少ID不偷偷新建", async () => {
  const session = { id: "existing" },
    onSession = vi.fn();
  mocks.open.mockResolvedValue(session);
  mocks.json.mockImplementation(async (options) => {
    await expect(
      options.ensureSession({ sessionId: "different", onSession }),
    ).rejects.toThrow("启动参数不一致");
    expect(await options.ensureSession({ onSession })).toBe(session);
    expect(mocks.ready).toHaveBeenCalledWith(
      "/private",
      session,
      expect.any(Function),
    );
    expect(onSession).toHaveBeenCalledWith(session);
  });
  await terminalChat("/private", {
    session: "existing",
    prompt: "continue",
    json: true,
  });
  expect(mocks.startup).not.toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledWith(
    "/private",
    expect.objectContaining({ sessionId: "existing" }),
  );
});
test("专属资源逐一清理，失败保留错误且不跳过其他句柄", async () => {
  const second = vi.fn();
  const context = {
    resources: () => [
      {
        close: () => {
          throw new Error("close failed");
        },
      },
      { close: second },
    ],
  } as unknown as StartupContext;
  await expect(closeStartup(context)).rejects.toThrow("启动资源清理失败");
  expect(second).toHaveBeenCalledOnce();
});

test("逐行审查传递客户端取消信号，等待预算由公共客户端管理", async () => {
  mocks.startup.mockResolvedValue({ resources: () => [] });
  mocks.activation.mockReturnValue({ close: () => ({ cleanupStartup: true }) });
  mocks.request.mockResolvedValue({ reviewId: "completed" });
  mocks.line.mockImplementation(async (options) => {
    expect(await options.request("existing", { type: "review" })).toEqual({
      reviewId: "completed",
    });
    expect(mocks.request).toHaveBeenCalledWith(
      "/private",
      "existing",
      { type: "review" },
      { signal: expect.any(AbortSignal) },
    );
  });
  await terminalChat("/private", {});
});
