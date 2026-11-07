import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { startInteractiveExec } from "../../src/docker/interactive.js";
import type Docker from "dockerode";
test("Docker交互启动附带stdin及TTY，退出inspect不明确时报错", async () => {
  const stream = new PassThrough();
  const exec = {
    start: vi.fn(async () => stream),
    inspect: vi.fn(async () => ({ Running: true, ExitCode: null })),
    resize: vi.fn(async () => {}),
  };
  const container = { exec: vi.fn(async () => exec) };
  const docker = { getContainer: () => container } as unknown as Docker;
  const interactive = await startInteractiveExec(docker, {
    containerId: "own-test",
    argv: ["agent"],
    env: {},
    tty: true,
  });
  expect(container.exec).toHaveBeenCalledWith(
    expect.objectContaining({ AttachStdin: true, Tty: true }),
  );
  // 创建和启动必须使用同一 TTY 模式，避免原生屏幕混入复用头。
  expect(exec.start).toHaveBeenCalledWith({ hijack: true, stdin: true, Tty: true });
  const completion = expect(interactive.completion).rejects.toThrow("结果不明");
  stream.emit("end");
  await completion;
});
test("非TTY使用Docker解复用，resize不调用exec", async () => {
  const stream = new PassThrough();
  const resize = vi.fn(async () => {});
  const exec = {
    start: vi.fn(async () => stream),
    inspect: async () => ({ Running: false, ExitCode: 137 }),
    resize,
  };
  const demuxStream = vi.fn();
  const docker = {
    getContainer: () => ({ exec: async () => exec }),
    modem: { demuxStream },
  } as unknown as Docker;
  const interactive = await startInteractiveExec(docker, {
    containerId: "test",
    argv: ["agent"],
    env: {},
    tty: false,
  });
  expect(exec.start).toHaveBeenCalledWith({ hijack: true, stdin: true, Tty: false });
  expect(demuxStream).toHaveBeenCalledOnce();
  await interactive.resize(80, 24);
  expect(resize).not.toHaveBeenCalled();
  stream.emit("end");
  await expect(interactive.completion).resolves.toBe(137);
});
