import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { startDevelopmentSessionWorker } from "../../src/sessions/runtime.js";
import {
  requestSessionWorker,
  sessionWorkerPaths,
} from "../../src/sessions/worker-api.js";
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  audit: vi.fn(),
  codex: vi.fn(),
  claude: vi.fn(),
  opencode: vi.fn(),
  review: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../../src/sessions/environment.js", () => ({
  ensureSessionEnvironment: mocks.prepare,
}));
vi.mock("../../src/sessions/audit.js", () => ({
  startSessionAudit: mocks.audit,
}));
vi.mock("../../src/agents/sessions/codex-driver.js", () => ({
  createCodexDriver: mocks.codex,
}));
vi.mock("../../src/agents/sessions/claude-driver.js", () => ({
  createStructuredClaudeDriver: mocks.claude,
}));
vi.mock("../../src/agents/sessions/opencode-driver.js", () => ({
  createOpenCodeDriver: mocks.opencode,
}));
vi.mock("../../src/sessions/review/report.js", () => ({
  reviewSession: mocks.review,
  retrySessionReview: mocks.retry,
}));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({
    getContainer: () => ({
      wait: ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          abortSignal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    }),
  }),
}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  vi.clearAllMocks();
});
async function fixture(agent: "codex" | "claude-code" | "opencode" = "codex") {
  const home = await mkdtemp(join(tmpdir(), "relay-run-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const session = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent,
  });
  const task = {
    id: randomUUID(),
    projectId: "test",
    projectRoot: cwd,
    prompt: "native",
    containerId: "test-container",
    config: configSchema.parse({}),
    configDigest: "test",
    state: "prepared",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    round: 0,
    checks: [],
    warnings: [],
  };
  const profile = profileSchema.parse({
    endpoint: "https://example.test",
    model: "test",
    apiKeyEnv: "DEV_TEST_KEY",
    protocol: "responses",
    image: `image@sha256:${"a".repeat(64)}`,
    networkImage: `network@sha256:${"b".repeat(64)}`,
  });
  mocks.prepare.mockImplementation(async () => {
    expect(
      await readFile(sessionWorkerPaths(home, session.id).lock, "utf8"),
    ).toContain("pid");
    return {
      session,
      task,
      profile,
      env: { RELAY_API_KEY: "development-key" },
    };
  });
  const audit = {
    finish: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => ({})),
    index: vi.fn(async () => ({})),
  };
  mocks.audit.mockResolvedValue(audit);
  const submit = vi.fn(async () => {}),
    close = vi.fn(async () => {});
  const ready = vi.fn(async () => {
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
  const execute = vi.fn(async () => {});
  const factory = (input: {
    bindNativeSession?(id: string): Promise<void>;
    bindNative?(id: string): Promise<void>;
  }) => {
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const bind = input.bindNativeSession ?? input.bindNative!;
    return bind("native").then(() => ({
      submit,
      execute,
      close,
      ready,
      capabilities: async () => ({
        skills: {
          list: { status: "supported" },
          invoke: { status: "supported" },
        },
      }),
      listSkills: async () => [],
      get nativeLaunch() {
        throw new Error("不得读取原生启动");
      },
      stop: async () => {},
    }));
  };
  mocks.opencode.mockImplementation(factory);
  mocks.claude.mockImplementation(() => ({
    submit,
    execute,
    close,
    ready,
    capabilities: async () => ({
      skills: {
        list: { status: "supported" },
        invoke: { status: "unsupported", reason: "unsupported" },
      },
    }),
    listSkills: async () => [],
    stop: async () => {},
  }));
  mocks.codex.mockImplementation(factory);
  mocks.review.mockResolvedValue({
    record: { id: "new" },
    summary: "reviewed",
  });
  mocks.retry.mockResolvedValue({
    record: { id: "retry" },
    summary: "retried",
  });
  return { home, session, audit, submit, execute, ready, close };
}
// 用真实 worker socket 装配假驱动，不连接 Docker 或真实模型。
test("独占之后先审计再启动纯结构化驱动，结构化和审查共用worker", async () => {
  const f = await fixture();
  const worker = await startDevelopmentSessionWorker(f.home, f.session.id);
  cleanup.push(() => worker.close());
  await expect(
    requestSessionWorker(f.home, f.session.id, { type: "native" }),
  ).rejects.toThrow(/原生终端/);
  const accepted = await requestSessionWorker(f.home, f.session.id, {
    type: "submit",
    prompt: "one",
  });
  await expect.poll(() => f.execute.mock.calls.length).toBe(1);
  // 旧 submit 协议也必须先保存，再转换为统一 message 执行。
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.execute).toHaveBeenCalledWith(
    { type: "message", prompt: "one" },
    expect.objectContaining({
      lease: expect.objectContaining({ token: expect.any(String) }),
    }),
  );
  expect(
    JSON.parse(
      await readFile(
        join(
          f.home,
          "sessions",
          f.session.id,
          "requests",
          `${accepted.requestId}.json`,
        ),
        "utf8",
      ),
    ),
  ).toMatchObject({
    status: "accepted",
    request: { type: "message", prompt: "one" },
  });
  await expect
    .poll(
      async () =>
        (await requestSessionWorker(f.home, f.session.id, { type: "status" }))
          .state,
    )
    .toMatchObject({ phase: "idle" });
  expect(
    await requestSessionWorker(f.home, f.session.id, { type: "review" }),
  ).toMatchObject({ summary: "reviewed" });
  expect(
    await requestSessionWorker(f.home, f.session.id, {
      type: "review",
      evidenceId: randomUUID(),
    }),
  ).toMatchObject({ summary: "retried" });
  await expect(
    startDevelopmentSessionWorker(f.home, f.session.id),
  ).rejects.toThrow(/存在/);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(mocks.codex).toHaveBeenCalledTimes(1);
  expect(mocks.codex.mock.calls[0]![0].context.environment).toEqual({
    RELAY_API_KEY: "development-key",
  });
  expect(f.audit.finish).not.toHaveBeenCalled();
});
test("厂商初始化失败收尾审计且不留下worker锁", async () => {
  const f = await fixture();
  mocks.codex.mockRejectedValueOnce(new Error("启动失败 development-key"));
  await expect(
    startDevelopmentSessionWorker(f.home, f.session.id),
  ).rejects.toThrow(/启动失败/);
  expect(f.audit.finish).toHaveBeenCalledTimes(1);
  expect(
    await readFile(sessionWorkerPaths(f.home, f.session.id).diagnostic, "utf8"),
  ).not.toContain("development-key");
});

// 三种厂商共享审计顺序；Claude readiness 完成前不能发布公共控制入口。
test.each(["claude-code", "opencode"] as const)(
  "%s 只装配结构化能力",
  async (agent) => {
    const f = await fixture(agent);
    const worker = await startDevelopmentSessionWorker(f.home, f.session.id);
    cleanup.push(() => worker.close());
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(
      agent === "claude-code" ? mocks.claude : mocks.opencode,
    ).toHaveBeenCalledTimes(1);
    expect(
      (agent === "claude-code" ? mocks.claude : mocks.opencode).mock
        .calls[0]![0].environment,
    ).toEqual({ RELAY_API_KEY: "development-key" });
    if (agent === "claude-code") expect(f.ready).toHaveBeenCalledTimes(1);
  },
);
test("Claude 就绪失败不发布 socket，收尾驱动和审计并脱敏", async () => {
  const f = await fixture("claude-code");
  f.ready.mockRejectedValueOnce(new Error("历史缺失 development-key"));
  await expect(
    startDevelopmentSessionWorker(f.home, f.session.id),
  ).rejects.toThrow(/历史缺失/);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.audit.finish).toHaveBeenCalledTimes(1);
  await expect(
    readFile(sessionWorkerPaths(f.home, f.session.id).socket),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(sessionWorkerPaths(f.home, f.session.id).diagnostic, "utf8"),
  ).not.toContain("development-key");
});
