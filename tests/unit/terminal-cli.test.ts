import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { terminalWorkerFixture } from "../helpers/terminal-worker.js";
import { readDevelopmentSession } from "../../src/terminal/session.js";

function events(output: string) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
// 真正启动构建前CLI与Unix协议；fake worker不等同真实Agent端到端验收。
test("实际CLI两轮复用外部与原生ID，after游标不重复投影", async () => {
  const f = await terminalWorkerFixture();
  try {
    const first = await f.launch({ prompt: "first input" }).completion;
    expect(first.code, first.stderr).toBe(0);
    expect(f.commands).toContain("execute");
    const firstEvents = events(first.stdout);
    expect(firstEvents.find((e) => e.type === "relay.session")?.sessionId).toBe(
      f.session.id,
    );
    const replay = firstEvents
      .filter((e) => e.type === "relay.event")
      .map((e) => e.event as { cursor: number; payload: { text?: string } });
    expect(replay.at(-1)?.payload.text).toBe("first");
    const after = replay.at(-1)!.cursor;
    const second = await f.launch({ prompt: "second input", after }).completion;
    expect(second.code, second.stderr).toBe(0);
    const secondEvents = events(second.stdout);
    expect(
      secondEvents.find((e) => e.type === "relay.session")?.sessionId,
    ).toBe(f.session.id);
    const next = secondEvents
      .filter((e) => e.type === "relay.event")
      .map((e) => e.event as { cursor: number; payload: { text?: string } });
    expect(next.every((e) => e.cursor > after)).toBe(true);
    expect(next.at(-1)?.payload.text).toBe("continued");
    expect(
      (
        await readDevelopmentSession(f.home, f.session.id, {
          cwd: f.cwd,
          projectId: "test",
          agent: "codex",
        })
      ).nativeSessionId,
    ).toBe("synthetic-native");
  } finally {
    await f.close();
  }
}, 30000);
test("实际CLI忙碌和后台执行故障均非零退出", async () => {
  const f = await terminalWorkerFixture();
  try {
    f.mode("busy");
    const busy = await f.launch({ prompt: "busy" }).completion;
    expect(busy.code).not.toBe(0);
    expect(busy.stdout).toContain("会话忙碌");
    f.mode("failure");
    const failed = await f.launch({ prompt: "failed" }).completion;
    expect(failed.code).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain("合成worker执行失败");
    expect(f.commands).not.toContain("stop");
  } finally {
    await f.close();
  }
}, 30000);

// 无模型、无容器的真实默认入口：打开、只读查看和退出都不产生正式身份。
test("实际默认逐行入口空查看退出不创建会话", async () => {
  const f = await terminalWorkerFixture();
  try {
    await mkdir(join(f.home, "profiles"), { recursive: true });
    await writeFile(
      join(f.home, "profiles", "relay-default.yaml"),
      JSON.stringify({
        endpoint: "http://127.0.0.1:1",
        model: "test",
        apiKeyEnv: "TEST_KEY",
        protocol: "responses",
        image: `sha256:${"a".repeat(64)}`,
        networkImage: `sha256:${"b".repeat(64)}`,
      }),
    );
    const before = await readdir(join(f.home, "sessions"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("src/cli/main.ts"),
        "--home",
        f.home,
        "--cwd",
        f.cwd,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const completed = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    child.stdin.end("\n/status\n/skills\n/exit\n");
    expect(await completed, output).toBe(0);
    expect(output).toContain("unstarted");
    expect(output).toContain("尚未初始化");
    expect(await readdir(join(f.home, "sessions"))).toEqual(before);
    expect(f.commands).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
