import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: mocks.connect }));
import { requestSessionWorker } from "../../src/sessions/worker-api.js";
afterEach(() => vi.useRealTimers());
// 使用连接事件验证请求生命周期，不启动真实worker或审查模型。
function connection() {
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn((error?: Error) => {
      if (error) socket.emit("error", error);
    }),
  });
  mocks.connect.mockReturnValue(socket);
  return socket;
}
test("显式长审查跨过默认期限，完成应答后关闭连接", async () => {
  vi.useFakeTimers();
  const socket = connection();
  const result = requestSessionWorker(
    "/tmp/r",
    "00000000-0000-4000-8000-000000000001",
    { type: "review" },
  );
  // 提前接管拒绝，以便红测不会产生未处理的异步异常。
  const outcome = result.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  socket.emit("connect");
  await vi.advanceTimersByTimeAsync(700000);
  expect(socket.destroy).not.toHaveBeenCalled();
  socket.emit("data", '{"ok":true,"result":{"reviewId":"done"}}\n');
  expect(await outcome).toEqual({ value: { reviewId: "done" } });
  expect(socket.destroy).toHaveBeenCalled();
});
test("普通请求仍在5秒超时，长审查连接错误仍可见", async () => {
  vi.useFakeTimers();
  const socket = connection();
  const ordinary = requestSessionWorker(
    "/tmp/r",
    "00000000-0000-4000-8000-000000000001",
    { type: "status" },
  );
  const outcome = ordinary.catch((error) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ message: "会话后台请求超时" });
  const second = connection();
  const review = requestSessionWorker(
    "/tmp/r",
    "00000000-0000-4000-8000-000000000001",
    { type: "review" },
  );
  const failure = expect(review).rejects.toThrow("connection lost");
  second.emit("error", new Error("connection lost"));
  await failure;
  expect(socket.destroy).toHaveBeenCalled();
});

// 取消仅销毁观察连接，不发送 stop，也不改变后台操作。
test("长审查可以取消等待，预先取消不建立连接", async () => {
  const socket = connection();
  const abort = new AbortController();
  const waiting = requestSessionWorker(
    "/tmp/r",
    "00000000-0000-4000-8000-000000000001",
    { type: "review" },
    { signal: abort.signal },
  );
  const rejected = expect(waiting).rejects.toMatchObject({
    name: "AbortError",
  });
  socket.emit("connect");
  abort.abort();
  await rejected;
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(socket.write).toHaveBeenCalledExactlyOnceWith('{"type":"review"}\n');
  mocks.connect.mockClear();
  await expect(
    requestSessionWorker(
      "/tmp/r",
      "00000000-0000-4000-8000-000000000001",
      { type: "review" },
      { signal: abort.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.connect).not.toHaveBeenCalled();
});
test("停止允许收尾但仍有180秒上限", async () => {
  vi.useFakeTimers();
  const socket = connection();
  const result = requestSessionWorker(
    "/tmp/r",
    "00000000-0000-4000-8000-000000000001",
    { type: "stop" },
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(179999);
  expect(socket.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ message: "会话后台请求超时" });
});
