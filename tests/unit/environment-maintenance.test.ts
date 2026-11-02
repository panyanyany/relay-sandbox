import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { afterEach, expect, test, vi } from "vitest";
import { installEnvironment } from "../../src/tasks/environment-install.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask } from "../../src/tasks/store.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";
import {
  stopEnvironment,
  stopEnvironments,
} from "../../src/tasks/environment-lifecycle.js";
import {
  saveEnvironmentState,
  loadEnvironmentState,
  type EnvironmentState,
} from "../../src/tasks/environment-state.js";
import { diagnoseEnvironment } from "../../src/tasks/environment-diagnostics.js";

const docker = vi.hoisted(() => ({
  listContainers: vi.fn(),
  listNetworks: vi.fn(),
  getContainer: vi.fn(),
}));
vi.mock("../../src/docker/client.js", () => ({ dockerClient: () => docker }));
vi.mock("../../src/decoys/install.js", () => ({
  installDecoys: vi.fn().mockImplementation(async () => {
    throw new Error("installation failure", {
      cause: new Error("Bearer private-value"),
    });
  }),
}));
const homes: string[] = [];
// 隔离宿主状态和Docker接口，验证失败重试及归属校验，不访问真实用户资源。
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-env-maint-"));
  homes.push(home);
  docker.listContainers.mockResolvedValue([]);
  docker.listNetworks.mockResolvedValue([]);
  await saveTask(home, {
    id: "task",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "x",
    config: configSchema.parse({}),
    configDigest: "c",
    state: "failed",
    createdAt: "",
    updatedAt: "",
    applicationStatus: "not_attempted",
    round: 0,
    checks: [],
    warnings: [],
  });
  return { home, root: join(home, "tasks/task") };
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
// 错误示范：坏JSON不能成为每次cleanup都失败、却永远无法隔离的活动记录。
test("坏记录在资源确认回收后隔离，cleanup可重复完成且保留证据", async () => {
  const { home, root } = await fixture();
  const environment = join(root, "traffic/broken");
  for (const part of ["ca", "private", "evidence"])
    await mkdir(join(environment, part), { recursive: true });
  await writeFile(join(environment, "summary.json"), "bad-json");
  await writeFile(join(environment, "handle.json"), "bad-handle");
  await writeFile(join(environment, "private/manifest.json"), "fake-value");
  await writeFile(join(environment, "evidence/events.jsonl"), "kept");
  expect((await cleanupTask(home, "task")).state).toBe("cleaned");
  expect((await cleanupTask(home, "task")).state).toBe("cleaned");
  expect(await loadEnvironmentState(home, "task", "broken")).toBeUndefined();
  const archive = join(root, "environment-quarantine/broken");
  const [generation] = await readdir(archive);
  expect(
    await readFile(join(archive, generation!, "summary.json"), "utf8"),
  ).toBe("bad-json");
  await expect(
    readFile(join(environment, "private/manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(join(environment, "evidence/events.jsonl"), "utf8"),
  ).toBe("kept");
});
test("无法核对代理列表时保留坏记录及私密材料，恢复后可重试", async () => {
  const { home, root } = await fixture();
  const directory = join(root, "traffic/broken");
  await mkdir(join(directory, "private"), { recursive: true });
  await writeFile(join(directory, "summary.json"), "bad-json");
  await writeFile(join(directory, "private/manifest.json"), "fake-value");
  docker.listContainers.mockRejectedValueOnce(new Error("Docker unavailable"));
  await expect(
    stopEnvironments(docker as unknown as Docker, home, "task"),
  ).rejects.toThrow();
  expect(await readFile(join(directory, "summary.json"), "utf8")).toBe(
    "bad-json",
  );
  expect(await readFile(join(directory, "private/manifest.json"), "utf8")).toBe(
    "fake-value",
  );
  await stopEnvironments(docker as unknown as Docker, home, "task");
  expect(await loadEnvironmentState(home, "task", "broken")).toBeUndefined();
});
test("单环境收尾统一清除入口，归属不符时不删除无关容器并保留重试句柄", async () => {
  const { home } = await fixture();
  const state: EnvironmentState = {
    summary: {
      schemaVersion: 1,
      runtimeId: "check",
      containerId: "dev",
      role: "check",
      enabled: true,
      traffic: "ready",
      placements: [],
      gaps: [],
      helperRoot: "/opt/relay-sandbox/audit/check",
    },
    handle: {
      containerId: "proxy",
      privateDirectory: join(home, "tasks/task/traffic/check"),
    },
  };
  await saveEnvironmentState(home, "task", state);
  const remove = vi.fn().mockResolvedValue(undefined);
  const inspect = vi.fn().mockResolvedValue({
    Config: {
      Labels: {
        "relay-sandbox.task": "other",
        "relay-sandbox.kind": "traffic-proxy",
      },
    },
  });
  docker.getContainer.mockReturnValue({ inspect, remove });
  await expect(
    stopEnvironment(docker as unknown as Docker, home, "task", state),
  ).rejects.toThrow();
  expect(remove).not.toHaveBeenCalled();
  expect(state.summary.traffic).toBe("cleanup_pending");
  expect(state.handle).toBeDefined();
  expect(state.summary.helperRoot).toBeUndefined();
  inspect.mockResolvedValue({
    Config: {
      Labels: {
        "relay-sandbox.task": "task",
        "relay-sandbox.kind": "traffic-proxy",
      },
    },
  });
  await stopEnvironment(docker as unknown as Docker, home, "task", state);
  expect(state.summary.traffic).toBe("stopped");
  expect(state.handle).toBeUndefined();
  expect(
    (await loadEnvironmentState(home, "task", "check"))?.summary.helperRoot,
  ).toBeUndefined();
});
test("降级诊断保留阶段、原因和堆栈，凭据脱敏", async () => {
  const { home, root } = await fixture();
  await diagnoseEnvironment(
    home,
    "task",
    "main",
    "traffic-tools-failed",
    new Error("install failed", { cause: new Error("Bearer private-value") }),
  );
  const text = await readFile(
    join(root, "traffic/main/diagnostics/traffic-tools-failed.json"),
    "utf8",
  );
  expect(text).toContain("install failed");
  expect(text).toContain("environment-maintenance.test.ts");
  expect(text).toContain("原因");
  expect(text).not.toContain("private-value");
});

// 可选安装失败只降级观察，诊断失败也通过stderr留证而不阻断开发。
test("诱饵安装失败仍返回覆盖缺口并保存脱敏原因", async () => {
  const { home, root } = await fixture();
  const state = await installEnvironment(docker as unknown as Docker, {
    home,
    taskId: "task",
    runtimeId: "main",
    containerId: "dev",
    policy: {
      ...hostPermissionsSchema.parse({ decoys: { enabled: true } }),
      schemaVersion: 1,
    },
  });
  expect(state.summary.traffic).toBe("unavailable");
  expect(state.summary.gaps).toContain("decoy-install-failed");
  const text = await readFile(
    join(root, "traffic/main/diagnostics/decoy-install-failed.json"),
    "utf8",
  );
  expect(text).toContain("installation failure");
  expect(text).not.toContain("private-value");
  await writeFile(join(root, "traffic/main/diagnostics/unwritable.json"), "{}");
  await rm(join(root, "traffic/main/diagnostics"), { recursive: true });
  await writeFile(join(root, "traffic/main/diagnostics"), "not-directory");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await expect(
      diagnoseEnvironment(
        home,
        "task",
        "main",
        "traffic-tools-failed",
        new Error("original failure"),
      ),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("original failure"),
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("环境降级诊断写入失败"),
    );
  } finally {
    stderr.mockRestore();
  }
});
