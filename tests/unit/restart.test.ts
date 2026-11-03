import { beforeEach, expect, test, vi } from "vitest";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import { restartTaskRuntime } from "../../src/tasks/restart.js";
import type { Task } from "../../src/tasks/types.js";
import { synchronizeResumedWorkspace } from "../../src/tasks/resume-workspace.js";

const calls = vi.hoisted(() => ({
  start: vi.fn(),
  network: vi.fn(),
  audit: vi.fn(),
  stop: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../src/docker/client.js", () => ({
  dockerClient: () => ({ getContainer: () => ({ start: calls.start }) }),
}));
vi.mock("../../src/network/policy.js", () => ({
  installPolicy: calls.network,
}));
vi.mock("../../src/permissions/freeze.js", () => ({
  readFrozenPolicy: async () => ({ network: { grants: [] } }),
}));
vi.mock("../../src/tasks/environment-install.js", () => ({
  installEnvironment: calls.audit,
}));
vi.mock("../../src/tasks/cleanup.js", () => ({
  stopTaskResources: calls.stop,
}));
vi.mock("../../src/tasks/store.js", () => ({ saveTask: calls.save }));
vi.mock("../../src/tasks/resume-workspace.js", () => ({
  synchronizeResumedWorkspace: vi.fn(),
}));
const profile = profileSchema.parse({
  endpoint: "https://fixture.invalid/v1",
  model: "fixture",
  protocol: "responses",
  image: `sha256:${"a".repeat(64)}`,
  networkImage: `sha256:${"a".repeat(64)}`,
  apiKeyEnv: "TEST_KEY",
});
function task() {
  return {
    id: "fixture",
    containerId: "container",
    networkId: "network",
    config: configSchema.parse({}),
    warnings: [],
  } as unknown as Task;
}
beforeEach(() => {
  vi.resetAllMocks();
});

// 同一故障矩阵覆盖两个入口共用的规则，网络失败不能被审计降级吞掉。
test.each(["resume", "rework"] as const)(
  "%s审计失败降级，网络与持久化失败停止",
  async (reason) => {
    calls.audit.mockRejectedValue(new Error("synthetic audit EACCES"));
    const current = task();
    await restartTaskRuntime("/fixture", current, profile, reason);
    expect(current.warnings[0]).toContain("synthetic audit EACCES");
    expect(calls.stop).not.toHaveBeenCalled();
    calls.network.mockRejectedValueOnce(new Error("network failed"));
    await expect(
      restartTaskRuntime("/fixture", task(), profile, reason),
    ).rejects.toThrow("network failed");
    expect(calls.stop).toHaveBeenCalledTimes(1);
    calls.save.mockRejectedValueOnce(new Error("state failed"));
    await expect(
      restartTaskRuntime("/fixture", task(), profile, reason),
    ).rejects.toThrow("state failed");
    expect(calls.stop).toHaveBeenCalledTimes(2);
  },
);

test("启动与清理失败保留两个异常及原因链", async () => {
  const initial = new Error("start failed"),
    cleanup = new Error("stop failed");
  calls.start.mockRejectedValue(initial);
  calls.stop.mockRejectedValue(cleanup);
  const error = await restartTaskRuntime(
    "/fixture",
    task(),
    profile,
    "rework",
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([initial, cleanup]);
  expect((error as Error).cause).toBe(initial);
});

// 交付收尾已经持有环境锁并有独立同步步骤，不能再次进入恢复同步。
test("交付内部启动不重复同步或使已通过审核失效", async () => {
  await restartTaskRuntime("/fixture", task(), profile, "delivery", false);
  expect(synchronizeResumedWorkspace).not.toHaveBeenCalled();
});
