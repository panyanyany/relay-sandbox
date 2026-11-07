import { expect, test, vi } from "vitest";
import { watchDevelopmentContainer } from "../../src/sessions/backend-lifecycle.js";
// Docker wait 是唯一事件源；退出0同样是意外停止，不能只识别 OOM。
test.each([0, 137])("容器意外停止立即传播 exit=%s", async (code) => {
  const fail = vi.fn(async () => {});
  const watcher = watchDevelopmentContainer(
    {
      wait: async () => ({ StatusCode: code }),
      inspect: async () => ({ State: { OOMKilled: false } }),
    },
    fail,
  );
  await watcher.completion;
  expect(fail).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining(`exit=${code}`),
    }),
  );
});
test("显式停止和关闭取消wait不误报崩溃", async () => {
  const fail = vi.fn(async () => {});
  let resolve!: (value: { StatusCode: number }) => void;
  const watcher = watchDevelopmentContainer(
    {
      wait: () =>
        new Promise((r) => {
          resolve = r;
        }),
      inspect: async () => ({ State: { OOMKilled: false } }),
    },
    fail,
  );
  watcher.close();
  resolve({ StatusCode: 137 });
  await watcher.completion;
  expect(fail).not.toHaveBeenCalled();
});

// 错误示范：在 driver.stop 前 close，会在停止失败后永久丢失退出证据。
test.each([true, false])(
  "停止失败仍监测退出，退出发生在停止期间=%s",
  async (during) => {
    let exit!: (value: { StatusCode: number }) => void;
    const fail = vi.fn(async () => {});
    const watcher = watchDevelopmentContainer(
      {
        wait: () =>
          new Promise((resolve) => {
            exit = resolve;
          }),
        inspect: async () => ({ State: { OOMKilled: true } }),
      },
      fail,
    );
    await expect(
      watcher.duringStop(async () => {
        if (during) {
          exit({ StatusCode: 137 });
          await Promise.resolve();
        }
        throw new Error("stop failed");
      }),
    ).rejects.toThrow("stop failed");
    if (!during) exit({ StatusCode: 137 });
    await watcher.completion;
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("exit=137") }),
    );
  },
);
test("完整停止成功才确认预期退出", async () => {
  let exit!: (value: { StatusCode: number }) => void;
  const fail = vi.fn(async () => {});
  const watcher = watchDevelopmentContainer(
    {
      wait: () =>
        new Promise((resolve) => {
          exit = resolve;
        }),
      inspect: async () => ({ State: { OOMKilled: false } }),
    },
    fail,
  );
  await watcher.duringStop(async () => {
    exit({ StatusCode: 0 });
    await Promise.resolve();
  });
  await watcher.completion;
  expect(fail).not.toHaveBeenCalled();
});
