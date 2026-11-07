import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerProject } from "../../src/projects/registry.js";
import {
  createDevelopmentSession,
  bindNativeSession,
} from "../../src/terminal/session.js";
import {
  appendSessionEvent,
  replaySessionEvents,
} from "../../src/sessions/event-store.js";
import { sessionWorkerPaths } from "../../src/sessions/worker-api.js";

// 真实CLI连接私有Unix假worker；只验证接入协议，不模拟原生Agent或Docker。
export async function terminalWorkerFixture() {
  const home = await mkdtemp(join(tmpdir(), "cli-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  await registerProject(home, "test", cwd);
  const created = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
  });
  const session = await bindNativeSession(
    home,
    created.id,
    { cwd, projectId: "test", agent: "codex" },
    "synthetic-native",
  );
  const path = sessionWorkerPaths(home, session.id).socket;
  let turns = 0,
    delayMs = 0,
    busy = false,
    mode: "normal" | "busy" | "failure" = "normal";
  const commands: string[] = [],
    sockets = new Set<Socket>(),
    timers = new Set<NodeJS.Timeout>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        const command = JSON.parse(input.slice(0, input.indexOf("\n"))) as {
          type: string;
          prompt?: string;
          request?: { type: string; prompt?: string };
          after?: number;
        };
        commands.push(command.type);
        let result: unknown;
        if (command.type === "status")
          result = {
            workerPid: process.pid,
            state: { phase: busy ? "busy" : "idle" },
            ...(mode === "failure" ? { failure: "合成worker执行失败" } : {}),
          };
        else if (command.type === "events")
          result = await replaySessionEvents(
            home,
            session.id,
            command.after ?? 0,
          );
        else if (command.type === "submit" || command.type === "execute") {
          if (mode === "busy" || busy) throw new Error("会话忙碌");
          turns++;
          busy = true;
          await appendSessionEvent(home, session.id, {
            type: "message",
            payload: {
              role: "user",
              text: command.request?.prompt ?? command.prompt!,
              complete: true,
            },
          });
          const finish = async () => {
            await appendSessionEvent(home, session.id, {
              type: "message",
              payload: {
                role: "assistant",
                text: turns === 1 ? "first" : "continued",
                complete: true,
              },
            });
            busy = false;
          };
          if (delayMs) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              void finish();
            }, delayMs);
            timers.add(timer);
          } else await finish();
          result = { accepted: true };
        } else if (command.type === "review") {
          // 模拟已接受的长审查，客户端断开不取消后台计时。
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              timers.delete(timer);
              resolve();
            }, delayMs);
            timers.add(timer);
          });
          result = { reviewId: "synthetic-review" };
        } else throw new Error(`测试未支持命令: ${command.type}`);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      })().catch((error: Error) =>
        socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n"),
      );
    });
  });
  server.listen(path);
  await once(server, "listening");
  const children = new Set<ReturnType<typeof spawn>>();
  function launch(
    input: { prompt: string; after?: number } | { command: "review" },
  ) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("src/cli/main.ts"),
        "--home",
        home,
        "chat",
        "--cwd",
        cwd,
        "--json",
        "--input-json",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const completion = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        children.delete(child);
        resolveExit({ code, stdout, stderr });
      });
    });
    child.stdin!.end(
      JSON.stringify({ ...input, sessionId: session.id }) + "\n",
    );
    return { child, completion, output: () => stdout };
  }
  return {
    home,
    cwd,
    session,
    commands,
    launch,
    mode(value: typeof mode) {
      mode = value;
    },
    delay(value: number) {
      delayMs = value;
    },
    async close() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([...children].map((child) => once(child, "close")));
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(home, { recursive: true, force: true });
    },
  };
}
