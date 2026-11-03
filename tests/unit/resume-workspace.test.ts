import { prepareDelivery } from "../../src/tasks/prepare.js";
import { taskResult } from "../../src/tasks/result.js";
import { scan, manifestDigest } from "../../src/workspace/manifest.js";
import { writeJson } from "../../src/storage/files.js";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { deliveryBaseline } from "../../src/tasks/delivery-baseline.js";
import { mergeCandidate } from "../../src/delivery/merge.js";
import { synchronizeResumedWorkspace } from "../../src/tasks/resume-workspace.js";
import { getTask, saveTask, taskPath } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";
import {
  readEnvironment,
  saveEnvironment,
  environmentPath,
} from "../../src/environments/store.js";

const calls = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../../src/docker/client.js", () => ({ dockerClient: () => ({}) }));
vi.mock("../../src/docker/archive.js", () => ({
  download: calls.download,
  upload: calls.upload,
}));
vi.mock("../../src/docker/execute.js", () => ({ execute: calls.execute }));
const roots: string[] = [];
// 保留真实快照、Git 文本三方合并和宿主状态文件，仅替换 Docker 传输。
async function fixture(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), "relay-resume-sync-"));
  roots.push(root);
  const home = join(root, "home"),
    host = join(root, "project"),
    container = join(root, "container");
  const task: Task = {
    id: "task",
    projectId: "project",
    projectRoot: host,
    containerId: "container",
    prompt: "fixture",
    config: configSchema.parse({ project: { exclude: ["secret"] } }),
    configDigest: "fixture",
    state: "failed",
    round: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
    checks: [],
    resultGeneration: "old",
    candidateGeneration: "old",
    deliveryPrepared: true,
  };
  const baseline = join(taskPath(home, task.id), "baseline");
  for (const path of [host, container, baseline])
    await mkdir(path, { recursive: true });
  const original = "first\nsecond\nthird\nfourth\nfifth\n";
  for (const path of [host, container, baseline])
    await writeFile(join(path, "file.txt"), original);
  if (persistent) {
    task.environmentId = "env";
    await cp(baseline, join(taskPath(home, task.id), "host-baseline"), {
      recursive: true,
    });
    await cp(
      baseline,
      join(environmentPath(home, task.projectId), "host-baseline"),
      { recursive: true },
    );
    await saveEnvironment(home, {
      version: 1,
      id: "env",
      projectId: task.projectId,
      signature: "fixture",
      mode: "persistent",
      idleRetentionHours: 24,
      activeTaskId: task.id,
      createdAt: task.createdAt,
    });
  }
  await saveTask(home, task);
  calls.download.mockImplementation(async (_docker, _id, destination) =>
    cp(container, destination, { recursive: true }),
  );
  calls.execute.mockImplementation(async (_docker, _id, argv) => {
    if (argv[0] === "/bin/rm")
      await rm(join(container, ".git"), { recursive: true, force: true });
    else {
      await rm(container, { recursive: true });
      await mkdir(container);
    }
    return { exitCode: 0 };
  });
  calls.upload.mockImplementation(async (_docker, _id, source) =>
    cp(source, container, { recursive: true }),
  );
  return { home, host, container, task, baseline, original };
}
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("无 Git 项目合并两侧文本修改，保留依赖和交付基线，推进持久环境检查点", async () => {
  const f = await fixture(true);
  await writeFile(
    join(f.host, "file.txt"),
    f.original.replace("first", "host"),
  );
  await writeFile(
    join(f.container, "file.txt"),
    f.original.replace("fifth", "agent"),
  );
  await writeFile(join(f.container, "dependency"), "installed");
  await writeFile(join(f.host, "secret"), "excluded");
  await synchronizeResumedWorkspace(f.home, f.task);
  expect(await readFile(join(f.container, "file.txt"), "utf8")).toBe(
    "host\nsecond\nthird\nfourth\nagent\n",
  );
  expect(await readFile(join(f.container, "dependency"), "utf8")).toBe(
    "installed",
  );
  await expect(readFile(join(f.container, "secret"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(f.baseline, "file.txt"), "utf8")).toBe(f.original);
  const delivery = join(f.home, "delivery");
  await cp(f.host, delivery, { recursive: true });
  expect(
    (
      await mergeCandidate(
        deliveryBaseline(f.home, f.task),
        f.container,
        f.host,
        delivery,
      )
    ).conflicts,
  ).toEqual([]);
  expect(await readFile(join(delivery, "file.txt"), "utf8")).toContain("agent");
  expect((await getTask(f.home, f.task.id)).resultGeneration).toBeUndefined();
  expect((await readEnvironment(f.home, f.task.projectId))?.needsReset).toBe(
    false,
  );
  expect(
    await readFile(
      join(
        environmentPath(f.home, f.task.projectId),
        "host-baseline",
        "file.txt",
      ),
      "utf8",
    ),
  ).toContain("host");
  // 宿主撤销上次修改时，必须使用上次成功检查点而非初始基线。
  await writeFile(join(f.host, "file.txt"), f.original);
  await synchronizeResumedWorkspace(f.home, f.task);
  expect(await readFile(join(f.container, "file.txt"), "utf8")).toBe(
    f.original.replace("fifth", "agent"),
  );
});

test("同一行冲突保留双方现场且不写容器，修正宿主后可重试", async () => {
  const f = await fixture();
  await writeFile(join(f.host, "file.txt"), "host\n");
  await writeFile(join(f.container, "file.txt"), "agent\n");
  await expect(synchronizeResumedWorkspace(f.home, f.task)).rejects.toThrow(
    "恢复同步冲突",
  );
  expect(calls.execute).not.toHaveBeenCalled();
  expect(calls.upload).not.toHaveBeenCalled();
  expect(await readFile(join(f.container, "file.txt"), "utf8")).toBe("agent\n");
  await writeFile(join(f.host, "file.txt"), f.original);
  await synchronizeResumedWorkspace(f.home, f.task);
  expect(await readFile(join(f.container, "file.txt"), "utf8")).toBe("agent\n");
});

test("传输失败保留备份并阻断重试，环境不得伪装同步成功", async () => {
  const f = await fixture(true);
  await writeFile(join(f.host, "new-host"), "force full merge");
  calls.upload.mockRejectedValue(new Error("synthetic upload failure"));
  await expect(synchronizeResumedWorkspace(f.home, f.task)).rejects.toThrow(
    "synthetic upload failure",
  );
  const saved = await getTask(f.home, f.task.id);
  expect(saved.workspaceSync?.status).toBe("applying");
  expect((await readEnvironment(f.home, f.task.projectId))?.needsReset).toBe(
    true,
  );
  expect(
    await readFile(
      join(
        taskPath(f.home, f.task.id),
        "resume-sync",
        saved.workspaceSync!.id,
        "before",
        "file.txt",
      ),
      "utf8",
    ),
  ).toBe(f.original);
  await expect(synchronizeResumedWorkspace(f.home, saved)).rejects.toThrow(
    "上次恢复同步未完成",
  );
  expect(calls.upload).toHaveBeenCalledTimes(1);
});

test("宿主新增与删除传播，单侧 Agent 新文件保留", async () => {
  const f = await fixture();
  await rm(join(f.host, "file.txt"));
  await writeFile(join(f.host, "new.txt"), "new");
  await writeFile(join(f.container, "agent.txt"), "unfinished");
  await synchronizeResumedWorkspace(f.home, f.task);
  await expect(readFile(join(f.container, "file.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(f.container, "new.txt"), "utf8")).toBe("new");
  expect(await readFile(join(f.container, "agent.txt"), "utf8")).toBe(
    "unfinished",
  );
});

// 二进制和同步期间宿主变动均须在写入前失败，不能强行选择一侧。
test("二进制双侧冲突不覆盖容器", async () => {
  const f = await fixture();
  await writeFile(join(f.host, "file.txt"), Buffer.from([0, 1]));
  await writeFile(join(f.container, "file.txt"), Buffer.from([0, 2]));
  await expect(synchronizeResumedWorkspace(f.home, f.task)).rejects.toThrow(
    "恢复同步冲突",
  );
  expect(calls.upload).not.toHaveBeenCalled();
});

test("宿主并发变化和持久宿主基线缺失明确失败", async () => {
  const f = await fixture(true);
  await writeFile(join(f.host, "new-host"), "force full merge");
  calls.download.mockImplementationOnce(async (_docker, _id, destination) => {
    await cp(f.container, destination, { recursive: true });
    await writeFile(
      join(f.host, "concurrent"),
      "changed during snapshot merge",
    );
  });
  await expect(synchronizeResumedWorkspace(f.home, f.task)).rejects.toThrow(
    "宿主项目发生变化",
  );
  expect(calls.execute).not.toHaveBeenCalled();
  await rm(join(taskPath(f.home, f.task.id), "host-baseline"), {
    recursive: true,
  });
  await expect(synchronizeResumedWorkspace(f.home, f.task)).rejects.toThrow(
    "缺少持久任务宿主基线",
  );
});

// 同步导入的宿主内容不能在交付时被当作 Agent 修改重新写回。
test.each(["revert", "modify", "delete"])(
  "恢复后宿主%s不被交付覆盖，中断成果保留",
  async (action) => {
    const f = await fixture(true);
    await writeFile(
      join(f.host, "file.txt"),
      f.original.replace("first", "imported"),
    );
    await writeFile(
      join(f.container, "file.txt"),
      f.original.replace("fifth", "agent"),
    );
    await writeFile(join(f.host, "host-only"), "host added");
    await synchronizeResumedWorkspace(f.home, f.task);
    if (action === "delete") {
      await rm(join(f.host, "host-only"));
    } else {
      await writeFile(
        join(f.host, "file.txt"),
        f.original.replace("first", action === "revert" ? "first" : "new-host"),
      );
    }
    const target = join(f.home, "delivery-after-host-change");
    await cp(f.host, target, { recursive: true });
    const merged = await mergeCandidate(
      deliveryBaseline(f.home, f.task),
      f.container,
      f.host,
      target,
    );
    expect(merged.conflicts).toEqual([]);
    const result = await readFile(join(target, "file.txt"), "utf8");
    expect(result).toContain("agent");
    if (action !== "delete")
      expect(
        result.startsWith(action === "revert" ? "first\n" : "new-host\n"),
      ).toBe(true);
    else
      await expect(readFile(join(target, "host-only"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

test("宿主无变化不导出或重传整个工作区，并清除内层 Git 配置", async () => {
  const f = await fixture();
  await writeFile(join(f.container, "agent-only"), "retained");
  await mkdir(join(f.container, ".git"));
  await writeFile(join(f.container, ".git", "config"), "untrusted");
  await synchronizeResumedWorkspace(f.home, f.task);
  expect(calls.download).not.toHaveBeenCalled();
  expect(
    calls.execute.mock.calls.every((call) => call[2][0] === "/bin/rm"),
  ).toBe(true);
  expect(await readFile(join(f.container, "agent-only"), "utf8")).toBe(
    "retained",
  );
  await expect(
    readFile(join(f.container, ".git", "config")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("旧成功检查点补建有效交付基线后，宿主撤销仍正确", async () => {
  const f = await fixture(true);
  await writeFile(
    join(f.host, "file.txt"),
    f.original.replace("first", "imported"),
  );
  await writeFile(
    join(f.container, "file.txt"),
    f.original.replace("fifth", "agent"),
  );
  await synchronizeResumedWorkspace(f.home, f.task);
  delete f.task.workspaceSync!.deliveryBase;
  delete f.task.workspaceSync!.version;
  await saveTask(f.home, f.task);
  calls.download.mockClear();
  await synchronizeResumedWorkspace(f.home, f.task);
  expect(calls.download).not.toHaveBeenCalled();
  expect(f.task.workspaceSync?.deliveryBase).toBeTruthy();
  await writeFile(join(f.host, "file.txt"), f.original);
  const target = join(f.home, "legacy-delivery");
  await cp(f.host, target, { recursive: true });
  expect(
    (
      await mergeCandidate(
        deliveryBaseline(f.home, f.task),
        f.container,
        f.host,
        target,
      )
    ).conflicts,
  ).toEqual([]);
  expect(await readFile(join(target, "file.txt"), "utf8")).toBe(
    f.original.replace("fifth", "agent"),
  );
});

test("实际交付入口读取有效基线，清理副本后仍可查询成果清单", async () => {
  const f = await fixture(true);
  f.task.config.delivery.aiReview = false;
  await writeFile(
    join(f.host, "file.txt"),
    f.original.replace("first", "imported"),
  );
  await writeFile(
    join(f.container, "file.txt"),
    f.original.replace("fifth", "agent"),
  );
  await synchronizeResumedWorkspace(f.home, f.task);
  await writeFile(join(f.host, "file.txt"), f.original);
  const root = taskPath(f.home, f.task.id);
  await writeJson(join(root, "result.json"), await scan(f.baseline));
  expect((await taskResult(f.home, f.task.id)).changes).toEqual([]);
  await cp(f.container, join(root, "result"), { recursive: true });
  const result = await scan(f.container);
  f.task.artifactDigest = manifestDigest(result);
  f.task.resultGeneration = "new";
  f.task.state = "checking";
  await writeJson(join(root, "result.json"), result);
  await saveTask(f.home, f.task);
  const prepared = await prepareDelivery(f.home, f.task.id);
  expect(prepared.conflicts).toEqual([]);
  expect(await readFile(join(root, "candidate", "file.txt"), "utf8")).toBe(
    f.original.replace("fifth", "agent"),
  );
  const task = await getTask(f.home, f.task.id);
  task.state = "cleaned";
  await saveTask(f.home, task);
  await rm(join(root, "resume-sync"), { recursive: true });
  expect(
    (await taskResult(f.home, f.task.id)).changes.map((change) => change.path),
  ).toContain("file.txt");
});
