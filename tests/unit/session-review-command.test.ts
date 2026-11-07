import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  retry: vi.fn(),
  task: vi.fn(),
}));
vi.mock("../../src/sessions/worker-api.js", () => ({
  requestSessionWorker: mocks.request,
}));
vi.mock("../../src/sessions/review/report.js", () => ({
  retrySessionReview: mocks.retry,
}));
vi.mock("../../src/tasks/deliver.js", () => ({ reviewTask: mocks.task }));
import { runSessionReview } from "../../src/cli/review-command.js";
let root: string | undefined;
afterEach(async () => {
  vi.resetAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "review-command-"));
  const session = await createDevelopmentSession(root, {
    cwd: root,
    projectId: "fixture",
    agent: "codex",
  });
  return { home: root, session };
}
test("明确--file继续走旧任务审核，不误用会话审查", async () => {
  const { home } = await fixture();
  const file = join(home, "decision.json");
  await writeFile(file, '{"decision":"fixture"}');
  mocks.task.mockResolvedValue({ accepted: true });
  await expect(runSessionReview(home, "task-id", { file })).resolves.toEqual({
    accepted: true,
  });
  expect(mocks.task).toHaveBeenCalledWith(home, "task-id", {
    decision: "fixture",
  });
  expect(mocks.request).not.toHaveBeenCalled();
});
test("会话审查由原后台持有，忙碌错误不离线绕过", async () => {
  const { home, session } = await fixture();
  mocks.request.mockRejectedValue(new Error("busy"));
  await expect(
    runSessionReview(home, session.id, { evidence: session.id }),
  ).rejects.toThrow("busy");
  expect(mocks.retry).not.toHaveBeenCalled();
});
// 错误示范：后台消失后重新启动开发再审查，会改变原材料。
test("只有明确固定证据允许离线补审，不隐式创建运行环境", async () => {
  const { home, session } = await fixture();
  mocks.request.mockRejectedValue(
    Object.assign(new Error("offline"), { code: "ECONNREFUSED" }),
  );
  mocks.retry.mockResolvedValue({ summary: "fixed" });
  await expect(runSessionReview(home, session.id, {})).rejects.toThrow(
    "offline",
  );
  await expect(
    runSessionReview(home, session.id, { evidence: session.id }),
  ).resolves.toEqual({ summary: "fixed" });
  expect(mocks.retry).toHaveBeenCalledWith({
    home,
    session,
    evidenceId: session.id,
  });
});
