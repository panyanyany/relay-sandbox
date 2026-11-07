import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { pack } from "tar-stream";
vi.mock("../../src/workspace/access.js", () => ({
  validateDirectRuntime: async (
    _home: string,
    task: { projectMode?: string },
  ) => task.projectMode === "direct",
}));
import { afterEach, expect, test, vi } from "vitest";
import { createDevelopmentSession } from "../../src/terminal/session.js";
import { configSchema } from "../../src/config/schema.js";
import { saveTask } from "../../src/tasks/store.js";
import {
  acquireSessionOperation,
  releaseSessionOperation,
} from "../../src/sessions/operation.js";
import { readSessionState } from "../../src/sessions/state.js";
import { withReviewEvidence } from "../../src/sessions/review/evidence.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 假 Docker 仍包含后台服务，验证冻结范围而不是只冻结主进程。
async function fixture(mode: "direct" | "isolated" = "direct") {
  const root = await mkdtemp(join(tmpdir(), "relay-review-"));
  roots.push(root);
  const cwd = join(root, "project"),
    home = join(root, "state");
  await mkdir(cwd);
  await writeFile(join(cwd, "a.txt"), "original");
  const id = randomUUID();
  const session = await createDevelopmentSession(home, {
    cwd,
    projectId: "test",
    agent: "codex",
    taskId: id,
    environmentId: id,
  });
  await saveTask(home, {
    id,
    projectId: "test",
    projectRoot: cwd,
    projectMode: mode,
    terminalSessionId: session.id,
    containerId: "main",
    environmentReady: true,
    prompt: "test",
    config: configSchema.parse({}),
    configDigest: "config",
    state: "prepared",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    round: 0,
    checks: [],
    warnings: [],
  });
  const calls: string[] = [];
  const paused = new Set<string>();
  const docker = {
    listContainers: vi.fn(async () =>
      ["main", "service", "already"].map((Id) => ({ Id })),
    ),
    getContainer: (id: string) => ({
      getArchive: async () => {
        const archive = pack();
        archive.entry({ name: "workspace/a.txt", type: "file" }, "original");
        archive.finalize();
        return archive;
      },
      inspect: async () => ({
        Config: {
          Labels: {
            "relay-sandbox.task": id === "foreign" ? "other" : session.taskId,
          },
        },
        State: { Running: true, Paused: id === "already" || paused.has(id) },
      }),
      pause: vi.fn(async () => {
        calls.push(`pause:${id}`);
        paused.add(id);
      }),
      unpause: vi.fn(async () => {
        calls.push(`unpause:${id}`);
        paused.delete(id);
      }),
    }),
  } as unknown as Docker;
  const audit = {
    snapshot: vi.fn(async () => ({
      coverage: "partial" as const,
      events: [],
      gaps: ["token=secret"],
      warnings: [],
    })),
    index: vi.fn(),
    finish: vi.fn(),
  };
  return { home, session, cwd, docker, audit, calls };
}
test("忙时立即拒绝，不冻结容器或调用采集器", async () => {
  const f = await fixture(),
    lease = await acquireSessionOperation(f.home, f.session.id, "development");
  await expect(
    withReviewEvidence(
      f.home,
      f.session,
      { docker: f.docker, audit: f.audit },
      async () => {},
    ),
  ).rejects.toThrow(/忙碌/);
  expect(f.docker.listContainers).not.toHaveBeenCalled();
  await releaseSessionOperation(f.home, f.session.id, lease);
});
test("冻结后台容器、固定私有版本并保持审查锁，不停止采集", async () => {
  const f = await fixture();
  await withReviewEvidence(
    f.home,
    f.session,
    { docker: f.docker, audit: f.audit },
    async (evidence) => {
      expect(f.calls).toEqual(["pause:main", "pause:service"]);
      expect(await readFile(join(evidence.codePath, "a.txt"), "utf8")).toBe(
        "original",
      );
      await writeFile(join(f.cwd, "a.txt"), "new");
      expect(await readFile(join(evidence.codePath, "a.txt"), "utf8")).toBe(
        "original",
      );
      expect(evidence.gaps.join()).not.toContain("secret");
      expect((await stat(evidence.root)).mode & 0o777).toBe(0o700);
      await expect(
        acquireSessionOperation(f.home, f.session.id, "development"),
      ).rejects.toThrow(/忙碌/);
    },
  );
  expect(f.audit.finish).not.toHaveBeenCalled();
  expect((await readSessionState(f.home, f.session.id)).phase).toBe("idle");
});
test("快照失败仍恢复所有本次暂停容器", async () => {
  const f = await fixture();
  f.audit.snapshot.mockRejectedValueOnce(new Error("snapshot failed"));
  await expect(
    withReviewEvidence(
      f.home,
      f.session,
      { docker: f.docker, audit: f.audit },
      async () => {},
    ),
  ).rejects.toThrow("snapshot failed");
  expect(f.calls).toContain("unpause:main");
});
test("恢复失败标记中断，不能伪装空闲", async () => {
  const f = await fixture();
  const original = f.docker.getContainer.bind(f.docker);
  vi.spyOn(f.docker, "getContainer").mockImplementation(
    (id) =>
      ({
        ...original(id),
        unpause: async () => {
          throw new Error("unpause failed");
        },
      }) as unknown as Docker.Container,
  );
  await expect(
    withReviewEvidence(
      f.home,
      f.session,
      { docker: f.docker, audit: f.audit },
      async () => {},
    ),
  ).rejects.toThrow();
  expect((await readSessionState(f.home, f.session.id)).phase).toBe(
    "interrupted",
  );
});

test("隔离模式复用归档导出并独立生成代码摘要", async () => {
  const f = await fixture("isolated");
  await withReviewEvidence(
    f.home,
    f.session,
    { docker: f.docker, audit: f.audit },
    async (evidence) => {
      expect(await readFile(join(evidence.codePath, "a.txt"), "utf8")).toBe(
        "original",
      );
      expect(evidence.codeDigest).toHaveLength(64);
    },
  );
});

// 容量错误必须失败并恢复，不能把被截断的代码当作完整候选。
test("直接快照执行累计预算，失败仍恢复冻结", async () => {
  const f = await fixture();
  const taskFile = join(f.home, "tasks", f.session.taskId!, "task.json");
  const task = JSON.parse(await readFile(taskFile, "utf8"));
  task.config.resources.maxExportBytes = 1;
  await writeFile(taskFile, JSON.stringify(task));
  await expect(
    withReviewEvidence(
      f.home,
      f.session,
      { docker: f.docker, audit: f.audit },
      async () => {},
    ),
  ).rejects.toThrow(/上限/);
  expect(f.calls).toContain("unpause:main");
});

test("不冻结标签属于其他任务的容器", async () => {
  const f = await fixture();
  vi.mocked(f.docker.listContainers).mockResolvedValue([
    { Id: "foreign" },
  ] as Docker.ContainerInfo[]);
  await withReviewEvidence(
    f.home,
    f.session,
    { docker: f.docker, audit: f.audit },
    async () => {},
  );
  expect(f.calls).toEqual(["pause:main", "unpause:main"]);
});
