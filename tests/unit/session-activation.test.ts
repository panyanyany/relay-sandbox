import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSessionActivation } from "../../src/sessions/activation.js";
import type { StartupContext } from "../../src/sessions/startup-context.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
// 只构造激活需要的可信身份，不复制配置或密钥。
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-activation-"));
  homes.push(home);
  const startup = {
    startupId: "00000000-0000-4000-8000-000000000001",
    home,
    projectId: "demo",
    cwd: home,
    agent: "codex",
  } as StartupContext;
  return { home, startup, activation: createSessionActivation(startup) };
}
const request = { type: "message", prompt: "hello" } as const;

test("身份和已接受请求在执行前完整可读；初始化失败仍保留", async () => {
  const { home, activation } = await fixture();
  let id = "";
  await expect(
    activation.submit(request, async (session) => {
      id = session.id;
      expect(
        JSON.parse(
          await readFile(join(home, "sessions", id, "session.json"), "utf8"),
        ).id,
      ).toBe(id);
      expect(
        JSON.parse(
          await readFile(
            join(home, "sessions", id, "first-request.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "accepted", request });
      throw new Error("Agent failed");
    }),
  ).rejects.toThrow("Agent failed");
  expect(activation.sessionId).toBe(id);
  expect(activation.close()).toEqual({ cleanupStartup: false });
  await expect(activation.submit(request, vi.fn())).rejects.toThrow("已提交");
});

test("保存失败不执行且不发布会话", async () => {
  const { home, activation } = await fixture();
  await writeFile(join(home, "sessions"), "blocked");
  const execute = vi.fn();
  await expect(activation.submit(request, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(activation.sessionId).toBeUndefined();
  expect(activation.close()).toEqual({ cleanupStartup: true });
});

test("关闭先获准则没有会话和执行", async () => {
  const { home, activation } = await fixture();
  expect(activation.close()).toEqual({ cleanupStartup: true });
  await expect(activation.submit(request, vi.fn())).rejects.toThrow("已关闭");
  expect(await readdir(home)).toEqual([]);
});

test("提交先获准则关闭不清后台，并发和重复只执行一次", async () => {
  const { startup, activation } = await fixture();
  expect(createSessionActivation(startup)).toBe(activation);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async () => {
    await barrier;
    return "done";
  });
  const accepted = activation.submit(request, execute);
  expect(activation.close()).toEqual({ cleanupStartup: false });
  await expect(activation.submit(request, execute)).rejects.toThrow("已提交");
  release();
  await expect(accepted).resolves.toMatchObject({ result: "done" });
  expect(execute).toHaveBeenCalledTimes(1);
});

test("无效输入不抢占首次准入，技能参数原样保存", async () => {
  const { home, activation } = await fixture();
  await expect(
    activation.submit({ type: "message", prompt: " " }, vi.fn()),
  ).rejects.toThrow();
  const skill = { type: "skill", name: "review", args: "  keep\n" } as const;
  const result = await activation.submit(skill, async () => undefined);
  expect(
    JSON.parse(
      await readFile(
        join(home, "sessions", result.session.id, "first-request.json"),
        "utf8",
      ),
    ).request,
  ).toEqual(skill);
});
