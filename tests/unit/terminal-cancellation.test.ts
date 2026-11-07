import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { terminalWorkerFixture } from "../helpers/terminal-worker.js";
import { replaySessionEvents } from "../../src/sessions/event-store.js";
import {
  createDevelopmentSession,
  readDevelopmentSession,
} from "../../src/terminal/session.js";

// 错误示范：网页或终端断开时按项目调用stopTask，会误停其他会话。
test("实际CLI收到SIGTERM仅断连，后台继续完成且同项目其他会话不变", async () => {
  const f = await terminalWorkerFixture();
  try {
    const other = await createDevelopmentSession(f.home, {
      cwd: f.cwd,
      projectId: "test",
      agent: "codex",
    });
    f.delay(1500);
    const run = f.launch({ prompt: "continue after disconnect" });
    const deadline = Date.now() + 15000;
    while (!run.output().includes("relay.accepted")) {
      if (Date.now() > deadline) throw new Error("CLI未确认接受输入");
      await delay(25);
    }
    run.child.kill("SIGTERM");
    const exited = await run.completion;
    expect(exited.code, exited.stderr).toBe(0);
    expect(f.commands).not.toContain("stop");
    while (
      !(await replaySessionEvents(f.home, f.session.id)).events.some(
        (e) => e.type === "message" && e.payload.role === "assistant",
      )
    ) {
      if (Date.now() > deadline) throw new Error("断连后后台未完成");
      await delay(25);
    }
    expect(
      (
        await readDevelopmentSession(f.home, other.id, {
          cwd: f.cwd,
          projectId: "test",
          agent: "codex",
        })
      ).updatedAt,
    ).toBe(other.updatedAt);
    expect(f.commands).not.toContain("stop");
  } finally {
    await f.close();
  }
}, 30000);

// SIGTERM 必须中断审查应答等待，而不是等完整模型预算。
test("实际CLI长审查期间SIGTERM正常退出且不停止后台", async () => {
  const f = await terminalWorkerFixture();
  try {
    f.delay(60000);
    const run = f.launch({ command: "review" });
    const deadline = Date.now() + 15000;
    while (!f.commands.includes("review")) {
      if (Date.now() > deadline) throw new Error("CLI未提交审查");
      await delay(25);
    }
    run.child.kill("SIGTERM");
    const watchdog = setTimeout(() => run.child.kill("SIGKILL"), 3000);
    try {
      const result = await run.completion;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("relay.error");
      expect(f.commands).not.toContain("stop");
    } finally {
      clearTimeout(watchdog);
    }
  } finally {
    await f.close();
  }
}, 30000);
