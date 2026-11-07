import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { processIdentity } from "../../src/tasks/lock.js";
import { createConnection } from "node:net";
import { dispatchSessionWorker } from "../../src/sessions/dispatch.js";
import { sessionWorkerPaths } from "../../src/sessions/worker-api.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import { startSessionWorker } from "../../src/sessions/worker.js";
import { requestSessionWorker } from "../../src/sessions/worker-api.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
async function fixture(
  submit: () => Promise<void>,
  native?: () => Promise<{ kind: "channel"; path: string }>,
) {
  const root = await mkdtemp(join(tmpdir(), "relay-worker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const session = await createDevelopmentSession(root, {
    cwd: join(root, "project"),
    projectId: "test",
    agent: "codex",
  });
  const worker = await startSessionWorker({
    home: root,
    id: session.id,
    driver: { submit, ...(native ? { native } : {}) },
  });
  cleanup.push(() => worker.close());
  return { home: root, id: session.id };
}
// 客户端收到准入后立即退出，后台轮次仍须完成，不排队第二条输入。
test("断开后完成可重读，忙碌立即拒绝，重复启动拒绝", async () => {
  let finish!: () => void;
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    await new Promise<void>((r) => {
      finish = r;
    });
  });
  await expect(
    startSessionWorker({ ...f, driver: { submit: async () => {} } }),
  ).rejects.toThrow(/存在/);
  expect(
    await requestSessionWorker(f.home, f.id, { type: "submit", prompt: "one" }),
  ).toMatchObject({ accepted: true });
  await expect(
    requestSessionWorker(f.home, f.id, { type: "submit", prompt: "two" }),
  ).rejects.toThrow(/忙碌/);
  expect(calls).toBe(1);
  finish();
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, f.id, { type: "status" })).state,
    )
    .toMatchObject({ phase: "idle" });
  const replay = await requestSessionWorker(f.home, f.id, {
    type: "events",
    after: 0,
  });
  expect(JSON.stringify(replay)).toContain("idle");
});
test("执行错误公开且脱敏，未知和过大命令拒绝", async () => {
  const f = await fixture(async () => {
    throw new Error("api_key=private failure");
  });
  await requestSessionWorker(f.home, f.id, { type: "submit", prompt: "fail" });
  await expect
    .poll(async () =>
      JSON.stringify(
        await requestSessionWorker(f.home, f.id, { type: "events", after: 0 }),
      ),
    )
    .toContain("failure");
  const result = JSON.stringify(
    await requestSessionWorker(f.home, f.id, { type: "events", after: 0 }),
  );
  expect(result).toContain("failed");
  expect(result).not.toContain("private");
  expect(
    await requestSessionWorker(f.home, f.id, { type: "status" }),
  ).toMatchObject({
    failure: expect.stringContaining("failure"),
    lastTurnFailure: expect.stringContaining("failure"),
  });
  expect(
    await requestSessionWorker(f.home, f.id, { type: "status" }),
  ).not.toHaveProperty("backendFailure");
  expect(
    await requestSessionWorker(f.home, f.id, {
      type: "submit",
      prompt: "retry",
    }),
  ).toMatchObject({ accepted: true });
  await expect(
    requestSessionWorker(f.home, f.id, { type: "unknown" } as never),
  ).rejects.toThrow();
  await expect(
    requestSessionWorker(f.home, f.id, {
      type: "submit",
      prompt: "x".repeat(70000),
    }),
  ).rejects.toThrow();
});

// 准入后直接断开连接，不能把 socket 的 close 当作取消请求。
test("不等待应答就断开也保留已准入执行", async () => {
  let finish!: () => void;
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    await new Promise<void>((r) => {
      finish = r;
    });
  });
  const socket = createConnection(sessionWorkerPaths(f.home, f.id).socket);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ type: "submit", prompt: "detached" }) + "\n");
  await expect.poll(() => calls).toBe(1);
  socket.destroy();
  finish();
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, f.id, { type: "status" })).state,
    )
    .toMatchObject({ phase: "idle" });
});
test("派发验证新进程归属，不接受旧后台；启动超时保留诊断", async () => {
  const f = await fixture(async () => {});
  const entry = join(f.home, "fake-worker.mjs");
  await writeFile(entry, "setInterval(()=>{},1000)");
  await expect(
    dispatchSessionWorker(f.home, f.id, { entry, timeoutMs: 500 }),
  ).rejects.toThrow(/其他后台/);
  const otherId = "11111111-1111-4111-8111-111111111111";
  await expect(
    dispatchSessionWorker(f.home, otherId, { entry, timeoutMs: 100 }),
  ).rejects.toThrow(/启动超时/);
  expect(
    await readFile(sessionWorkerPaths(f.home, otherId).diagnostic, "utf8"),
  ).toContain("启动超时");
});
// 实际 detached Node 子进程回报自己的 PID，确认派发握手而非仅测进程启动。
test("新后台只有身份匹配后才报告就绪", async () => {
  const f = await fixture(async () => {});
  const entry = join(f.home, "ready-worker.mjs");
  await writeFile(
    entry,
    `
    import { createServer } from 'node:net';
    import { join } from 'node:path';
    const home=process.argv[3], id=process.argv[5];
    createServer(socket=>socket.once('data',()=>socket.end(JSON.stringify({ok:true,result:{workerPid:process.pid}})+'\\n')))
      .listen(join(home,'sessions',id,'worker.sock'));
  `,
  );
  const id = "22222222-2222-4222-8222-222222222222";
  const status = await dispatchSessionWorker(f.home, id, {
    entry,
    timeoutMs: 3000,
  });
  const pid = Number(status.workerPid);
  cleanup.push(async () => {
    process.kill(pid, "SIGTERM");
  });
  expect(pid).toBeGreaterThan(0);
  expect(pid).not.toBe(process.pid);
});
// 工厂只能在后台独占归属确认后调用，拒绝前不能启动第二个原生进程。
test("重复 worker 不调用工厂，延迟工厂完成前不发布就绪 socket", async () => {
  const f = await fixture(async () => {});
  let calls = 0;
  await expect(
    startSessionWorker({
      ...f,
      driverFactory: async () => {
        calls++;
        return { submit: async () => {} };
      },
    }),
  ).rejects.toThrow(/存在/);
  expect(calls).toBe(0);
  const id = "33333333-3333-4333-8333-333333333333";
  let ready!: () => void;
  const pending = startSessionWorker({
    home: f.home,
    id,
    driverFactory: async (controls) => {
      expect(controls.emit).toBeTypeOf("function");
      calls++;
      await new Promise<void>((resolve) => {
        ready = resolve;
      });
      return { submit: async () => {} };
    },
  });
  await expect.poll(() => calls).toBe(1);
  await expect(
    requestSessionWorker(f.home, id, { type: "status" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  ready();
  const worker = await pending;
  cleanup.push(() => worker.close());
  expect(
    await requestSessionWorker(f.home, id, { type: "status" }),
  ).toHaveProperty("workerPid");
});
test("工厂失败记录脱敏诊断并释放自身后台锁", async () => {
  const f = await fixture(async () => {});
  const id = "44444444-4444-4444-8444-444444444444";
  await expect(
    startSessionWorker({
      home: f.home,
      id,
      secrets: ["private-native-key"],
      driverFactory: async () => {
        throw new Error("初始化失败 private-native-key");
      },
    }),
  ).rejects.toThrow(/初始化失败/);
  const paths = sessionWorkerPaths(f.home, id);
  expect(await readFile(paths.diagnostic, "utf8")).toContain("初始化失败");
  expect(await readFile(paths.diagnostic, "utf8")).not.toContain(
    "private-native-key",
  );
  await expect(readFile(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    requestSessionWorker(f.home, id, { type: "status" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

// 真正子进程退出后不再阻断显式恢复，其他会话的后台仍保持在线。
test.each([false, true])(
  "显式stop写回后独立后台自然退出，可判定旧worker已死亡（收尾失败=%s）",
  async (cleanupFails) => {
    const f = await fixture(async () => {});
    const id = "55555555-5555-4555-8555-555555555555";
    const entry = join(f.home, "stop-worker.mjs");
    await writeFile(
      entry,
      `import {startSessionWorker} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/sessions/worker.ts")).href)};
 const worker=await startSessionWorker({home:process.argv[2],id:process.argv[3],driver:{submit:async()=>{},stop:async()=>{},close:async()=>{if(${cleanupFails})throw new Error('cleanup failed');}}});await worker.completion;`,
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entry, f.home, id],
      { stdio: "ignore" },
    );
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    await expect
      .poll(
        async () => {
          try {
            return (await requestSessionWorker(f.home, id, { type: "status" }))
              .workerPid;
          } catch {
            return undefined;
          }
        },
        { timeout: 10000 },
      )
      .toBe(child.pid);
    expect(
      await requestSessionWorker(f.home, id, { type: "stop" }),
    ).toMatchObject({ stopped: true });
    expect(await exited).toBe(cleanupFails ? 1 : 0);
    expect(await processIdentity(child.pid!)).toBeUndefined();
    if (cleanupFails)
      expect(
        await readFile(sessionWorkerPaths(f.home, id).lock, "utf8"),
      ).toContain(String(child.pid));
    else
      await expect(
        readFile(sessionWorkerPaths(f.home, id).lock),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await requestSessionWorker(f.home, f.id, { type: "status" }),
    ).toHaveProperty("workerPid", process.pid);
  },
);

// 错误示范：只在驱动工厂脱敏，会让 structured submit 的消息绕过保护落盘。
test("submit与原生事件统一脱敏后落盘和回放", async () => {
  const f = await fixture(async () => {});
  const session = await createDevelopmentSession(f.home, {
    cwd: join(f.home, "project"),
    projectId: "test",
    agent: "codex",
  });
  const secret = "private-structured-key";
  const worker = await startSessionWorker({
    home: f.home,
    id: session.id,
    secrets: [secret],
    driverFactory: async (controls) => {
      await controls.emit({
        type: "gap",
        payload: { reason: `native ${secret}` },
      });
      return {
        submit: async (_prompt, context) => {
          await context.emit({
            type: "message",
            payload: {
              role: "assistant",
              text: `echo ${secret}`,
              complete: true,
              messageId: `message-${secret}`,
            },
          });
          await context.emit({
            type: "tool",
            payload: {
              name: `tool-${secret}`,
              callId: `call-${secret}`,
              phase: "completed",
              text: `result ${secret}`,
            },
          });
        },
      };
    },
  });
  cleanup.push(() => worker.close());
  await requestSessionWorker(f.home, session.id, {
    type: "submit",
    prompt: "echo",
  });
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, session.id, { type: "status" }))
          .state,
    )
    .toMatchObject({ phase: "idle" });
  const replay = JSON.stringify(
    await requestSessionWorker(f.home, session.id, {
      type: "events",
      after: 0,
    }),
  );
  const stored = await readFile(
    join(f.home, "sessions", session.id, "events.jsonl"),
    "utf8",
  );
  for (const output of [replay, stored]) {
    expect(output).toContain("[已脱敏]");
    expect(output).not.toContain(secret);
    expect(output).toContain("echo");
    expect(output).toContain("result");
  }
});

// 即使旧厂商对象仍带 native 方法，公共入口也不能重新打开执行旁路。
test("旧原生终端命令明确拒绝，不调用驱动", async () => {
  let calls = 0;
  const f = await fixture(
    async () => {},
    async () => {
      calls++;
      return { kind: "channel", path: "/tmp/obsolete-native.sock" };
    },
  );
  await expect(
    requestSessionWorker(f.home, f.id, { type: "native" }),
  ).rejects.toThrow(/原生终端.*不支持/);
  expect(calls).toBe(0);
  await expect(
    requestSessionWorker(f.home, f.id, { type: "status" }),
  ).resolves.toMatchObject({ state: { phase: "idle" } });
});
