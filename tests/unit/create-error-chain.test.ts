import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { configSchema, profileSchema } from "../../src/config/schema.js";
import * as config from "../../src/config/load.js";
import * as acquire from "../../src/environments/acquire.js";
import * as cleanup from "../../src/tasks/cleanup.js";
import { registerProject } from "../../src/projects/registry.js";
import { createTask } from "../../src/tasks/create.js";
import { listTasks } from "../../src/tasks/store.js";

// 真实创建入口和任务存储，故障只注入到环境准备与收尾边界。
test("创建失败保存准备及停止堆栈，专用凭据脱敏", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-create-error-"));
  try {
    const home = join(root, "home"),
      project = join(root, "project");
    await mkdir(project);
    await registerProject(home, "project", project);
    const image = `sha256:${"a".repeat(64)}`;
    const profile = profileSchema.parse({
      endpoint: "http://localhost:1234",
      model: "test",
      apiKeyEnv: "RELAY_ERROR_TEST_KEY",
      protocol: "responses",
      image,
      networkImage: image,
    });
    vi.stubEnv(profile.apiKeyEnv, "private-regression-credential");
    vi.spyOn(config, "loadConfig").mockResolvedValue(configSchema.parse({}));
    vi.spyOn(config, "loadProfile").mockResolvedValue(profile);
    vi.spyOn(acquire, "acquireEnvironment").mockImplementation(
      async (_home, task) => {
        task.environmentId = "env";
        throw new Error("prepare failure private-regression-credential");
      },
    );
    vi.spyOn(cleanup, "stopTaskResources").mockRejectedValue(
      new Error("stop failure"),
    );
    await expect(createTask(home, "project", "test")).rejects.toBeInstanceOf(
      AggregateError,
    );
    const [saved] = await listTasks(home);
    expect(saved?.state).toBe("failed");
    expect(saved?.error).toContain("prepare failure");
    expect(saved?.error).toContain("stop failure");
    expect(saved?.error).toContain("create-error-chain.test.ts");
    expect(saved?.error).toContain("[已脱敏]");
    expect(saved?.error).not.toContain("private-regression-credential");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
