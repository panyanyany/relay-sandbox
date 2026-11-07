import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parseSessionInput } from "../../src/sessions/commands.js";
import {
  startSessionWorker,
  type WorkerSessionDriver,
} from "../../src/sessions/worker.js";
import { requestSessionWorker } from "../../src/sessions/worker-api.js";
import { createDevelopmentSession } from "../../src/terminal/session.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
// 只读解析没有存储或启动依赖，原文不得被trim改写。
test("统一输入保留原文，有限命令与直接shell边界明确", () => {
  expect(parseSessionInput("  中文\n code ")).toEqual({
    type: "message",
    prompt: "  中文\n code ",
  });
  for (const type of [
    "help",
    "status",
    "exit",
    "stop",
    "review",
    "skills",
    "capabilities",
  ])
    expect(parseSessionInput(`/${type}`)).toEqual({ type });
  expect(parseSessionInput("/skill native/name 参数  二")).toEqual({
    type: "skill",
    name: "native/name",
    args: "参数  二",
  });
  expect(parseSessionInput("/skill review   keep\n  ")).toEqual({
    type: "skill",
    name: "review",
    args: "keep\n  ",
  });
  for (const value of ["/unknown", "!touch x", " /status extra", "/skill", " "])
    expect(() => parseSessionInput(value)).toThrow();
});
async function fixture(driver: WorkerSessionDriver) {
  const home = await mkdtemp(join(tmpdir(), "cmd-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const session = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
  });
  const worker = await startSessionWorker({ home, id: session.id, driver });
  cleanups.push(() => worker.close());
  return {
    home,
    id: session.id,
    directory: join(home, "sessions", session.id),
  };
}
const supported = {
  skills: {
    list: { status: "supported" as const },
    invoke: { status: "supported" as const },
  },
};
test("只读不准入，未知技能不执行，技能与消息共享锁且先可靠保存", async () => {
  let finish!: () => void;
  const execute = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const f = await fixture({
    submit: async () => {},
    execute,
    capabilities: async () => supported,
    listSkills: async () => [{ name: "known" }],
  });
  expect(await requestSessionWorker(f.home, f.id, { type: "skills" })).toEqual({
    skills: [{ name: "known" }],
  });
  expect(await readdir(f.directory)).not.toContain("requests");
  await expect(
    requestSessionWorker(f.home, f.id, {
      type: "execute",
      request: { type: "skill", name: "unknown" },
    }),
  ).rejects.toThrow(/未知/);
  expect(execute).not.toHaveBeenCalled();
  const accepted = await requestSessionWorker(f.home, f.id, {
    type: "execute",
    request: { type: "skill", name: "known" },
  });
  expect(accepted).toMatchObject({
    accepted: true,
    requestId: expect.any(String),
  });
  const saved = JSON.parse(
    await readFile(
      join(f.directory, "requests", `${accepted.requestId}.json`),
      "utf8",
    ),
  );
  expect(saved).toMatchObject({
    status: "accepted",
    request: { type: "skill", name: "known" },
  });
  await expect(
    requestSessionWorker(f.home, f.id, { type: "submit", prompt: "next" }),
  ).rejects.toThrow(/忙碌/);
  finish();
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, f.id, { type: "status" })).state,
    )
    .toMatchObject({ phase: "idle" });
});
test("请求保存失败零执行，Agent失败保留accepted记录且不重放", async () => {
  const execute = vi.fn(async () => {
    throw new Error("agent failed");
  });
  const f = await fixture({ submit: async () => {}, execute });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(f.directory, "requests"), "not a directory");
  await expect(
    requestSessionWorker(f.home, f.id, {
      type: "execute",
      request: { type: "message", prompt: "one" },
    }),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await rm(join(f.directory, "requests"));
  const accepted = await requestSessionWorker(f.home, f.id, {
    type: "execute",
    request: { type: "message", prompt: "中".repeat(65536) },
  });
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, f.id, { type: "status" })).failure,
    )
    .toContain("agent failed");
  expect(
    JSON.parse(
      await readFile(
        join(f.directory, "requests", `${accepted.requestId}.json`),
        "utf8",
      ),
    ),
  ).toMatchObject({ status: "accepted" });
  expect(execute).toHaveBeenCalledTimes(1);
});
test("未支持技能在准入前拒绝", async () => {
  const execute = vi.fn(async () => {});
  const f = await fixture({
    submit: async () => {},
    execute,
    capabilities: async () => ({
      skills: {
        list: { status: "unsupported", reason: "无列表" },
        invoke: { status: "unsupported", reason: "无调用" },
      },
    }),
  });
  await expect(
    requestSessionWorker(f.home, f.id, {
      type: "execute",
      request: { type: "skill", name: "known" },
    }),
  ).rejects.toThrow(/无调用/);
  expect(execute).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).not.toContain("requests");
});

// 错误示范：忙碌请求先查慢技能列表，会在首轮结束后被意外接收。
test("忙碌技能立即拒绝，不调用慢列表也不写第二请求", async () => {
  let finish!: () => void;
  const execute = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const listSkills = vi.fn(async () => {
    throw new Error("忙碌时不得查列表");
  });
  const capabilities = vi.fn(async () => supported);
  const f = await fixture({
    submit: async () => {},
    execute,
    capabilities,
    listSkills,
  });
  await requestSessionWorker(f.home, f.id, {
    type: "execute",
    request: { type: "message", prompt: "first" },
  });
  try {
    await expect(
      requestSessionWorker(f.home, f.id, {
        type: "execute",
        request: { type: "skill", name: "known" },
      }),
    ).rejects.toThrow(/忙碌/);
    expect(capabilities).not.toHaveBeenCalled();
    expect(listSkills).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await readdir(join(f.directory, "requests"))).toHaveLength(1);
  } finally {
    finish();
  }
});
