import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { registerProject } from "../../src/projects/registry.js";
import { writeJson } from "../../src/storage/files.js";
import {
  ensureSessionEnvironment,
  openDevelopmentSession,
} from "../../src/sessions/environment.js";
import type { Task } from "../../src/tasks/types.js";
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  prepare: vi.fn(),
  owner: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("../../src/tasks/create.js", () => ({
  reserveTask: mocks.reserve,
  prepareTask: mocks.prepare,
}));
vi.mock("../../src/environments/ownership.js", () => ({
  requireRuntimeOwner: mocks.owner,
}));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getContainer: () => ({ inspect: mocks.inspect }) }),
}));
let home: string, cwd: string, task: Task;
const profile = profileSchema.parse({
  endpoint: "https://example.test",
  model: "test",
  apiKeyEnv: "SESSION_TEST_KEY",
  protocol: "responses",
  image: `image@sha256:${"a".repeat(64)}`,
  networkImage: `network@sha256:${"b".repeat(64)}`,
});
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "session-env-"));
  cwd = join(home, "project");
  await mkdir(cwd);
  process.env.SESSION_TEST_KEY = "development-only";
  process.env.REVIEW_SECRET_TEST = "host-only";
  task = {
    id: randomUUID(),
    projectId: "demo",
    projectRoot: cwd,
    prompt: "native",
    config: configSchema.parse({}),
    configDigest: "digest",
    state: "preparing",
    environmentReady: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    round: 0,
    checks: [],
    warnings: [],
  };
  mocks.reserve.mockImplementation(async () => {
    await writeJson(join(home, "tasks", task.id, "task.json"), task);
    await writeJson(join(home, "tasks", task.id, "profile.json"), profile);
    return task;
  });
  mocks.prepare.mockImplementation(async () => {
    task = {
      ...task,
      state: "prepared",
      environmentReady: true,
      containerId: "container",
    };
    await writeJson(join(home, "tasks", task.id, "task.json"), task);
    return task;
  });
  mocks.owner.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({ State: { Running: true } });
});
afterEach(async () => {
  delete process.env.SESSION_TEST_KEY;
  delete process.env.REVIEW_SECRET_TEST;
  await rm(home, { recursive: true, force: true });
});
test("未注册目录不会隐式授权或创建任务", async () => {
  await expect(ensureSessionEnvironment(home, { cwd })).rejects.toThrow(
    "初始化",
  );
  expect(mocks.reserve).not.toHaveBeenCalled();
});
test("一个开发会话只准备一个任务，开发环境不混入宿主凭据", async () => {
  await registerProject(home, "demo", cwd);
  const first = await ensureSessionEnvironment(home, { cwd });
  const resumed = await ensureSessionEnvironment(home, {
    cwd,
    sessionId: first.session.id,
  });
  expect(resumed.session.taskId).toBe(task.id);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  expect(resumed.env).toEqual({ RELAY_API_KEY: "development-only" });
  expect(mocks.owner).toHaveBeenCalled();
});
test("准备失败后保留任务绑定以供诊断，不重复创建", async () => {
  await registerProject(home, "demo", cwd);
  mocks.prepare.mockRejectedValue(new Error("prepare failed"));
  await expect(ensureSessionEnvironment(home, { cwd })).rejects.toThrow(
    "prepare failed",
  );
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  const { readdir } = await import("node:fs/promises");
  const [id] = await readdir(join(home, "sessions"));
  await expect(
    ensureSessionEnvironment(home, { cwd, sessionId: id! }),
  ).rejects.toThrow("未就绪");
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
test("恢复拒绝被替换的项目与不运行的容器", async () => {
  await registerProject(home, "demo", cwd);
  const first = await ensureSessionEnvironment(home, { cwd });
  mocks.inspect.mockResolvedValue({ State: { Running: false } });
  await expect(
    ensureSessionEnvironment(home, { cwd, sessionId: first.session.id }),
  ).rejects.toThrow("未运行");
  task.config.developmentAgent.type = "claude-code";
  await writeJson(join(home, "tasks", task.id, "task.json"), task);
  await expect(
    ensureSessionEnvironment(home, { cwd, sessionId: first.session.id }),
  ).rejects.toThrow("身份");
});

test("持久环境使用准备后真实标识，所有权失效立即拒绝", async () => {
  await registerProject(home, "demo", cwd);
  task.environmentId = "persistent-real-id";
  const first = await ensureSessionEnvironment(home, { cwd });
  expect(first.session.environmentId).toBe("persistent-real-id");
  expect(first.task.terminalSessionId).toBe(first.session.id);
  mocks.owner.mockRejectedValue(new Error("ownership lost"));
  await expect(
    ensureSessionEnvironment(home, { cwd, sessionId: first.session.id }),
  ).rejects.toThrow("ownership lost");
});

test("冻结协议不匹配时明确失败，不读取宿主审查密钥", async () => {
  await registerProject(home, "demo", cwd);
  const first = await ensureSessionEnvironment(home, { cwd });
  await writeJson(join(home, "tasks", task.id, "profile.json"), {
    ...profile,
    protocol: "anthropic",
  });
  await expect(
    ensureSessionEnvironment(home, { cwd, sessionId: first.session.id }),
  ).rejects.toThrow("Responses");
});

// 错误示范：等镜像和项目准备结束才发送 ID，会让网页误判启动超时。
test("先返回授权会话标识，准备期间仍可只读打开同一会话", async () => {
  await registerProject(home, "demo", cwd);
  const session = await openDevelopmentSession(home, { cwd });
  expect(session.taskId).toBeUndefined();
  expect(mocks.reserve).not.toHaveBeenCalled();
  const { withSessionOperation } =
    await import("../../src/sessions/operation.js");
  await withSessionOperation(home, session.id, "development", async () => {
    expect(
      await openDevelopmentSession(home, { cwd, sessionId: session.id }),
    ).toEqual(session);
  });
});

test("OpenCode冻结档案同时配置原生serve的默认模型", async () => {
  await registerProject(home, "demo", cwd);
  task.config.developmentAgent.type = "opencode";
  mocks.reserve.mockImplementation(async () => {
    await writeJson(join(home, "tasks", task.id, "task.json"), task);
    await writeJson(join(home, "tasks", task.id, "profile.json"), {
      ...profile,
      protocol: "openai-compatible",
    });
    return task;
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(cwd, "relay-sandbox.yaml"),
    "developmentAgent:\n  type: opencode\n",
  );
  const result = await ensureSessionEnvironment(home, { cwd });
  expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
    model: "relay/test",
  });
  expect(result.env.REVIEW_SECRET_TEST).toBeUndefined();
});

// 入口应给出版本迁移提示，不能在获取 Agent 身份时提前抛出通用 Schema 错误。
test("打开旧宿主会话明确拒绝恢复并保留原历史", async () => {
  await registerProject(home, "demo", cwd);
  const id = randomUUID();
  const path = join(home, "sessions", id, "session.json");
  const legacy = {
    version: 1,
    id,
    cwd,
    host: "codex",
    nativeId: "old-host-thread",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(path, legacy);
  const original = await readFile(path, "utf8");
  await expect(
    openDevelopmentSession(home, { cwd, sessionId: id }),
  ).rejects.toThrow(
    "旧版宿主会话不能作为开发会话恢复，请新建开发会话；旧历史仍保留",
  );
  expect(await readFile(path, "utf8")).toBe(original);
  expect(mocks.reserve).not.toHaveBeenCalled();
});
