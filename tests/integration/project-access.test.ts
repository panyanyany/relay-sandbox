import {
  readFile,
  writeFile,
  readdir,
  rename,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { policyFixture } from "../helpers/policy-fixture.js";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { collectTask } from "../../src/tasks/run.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { applyTask, reviewTask } from "../../src/tasks/deliver.js";
import { getTask, taskPath } from "../../src/tasks/store.js";
import { resumeTask } from "../../src/tasks/recovery.js";
import { stopTask } from "../../src/tasks/cleanup.js";
import { startDirectProject } from "../../src/tasks/direct-project.js";
import { loadProfile } from "../../src/config/load.js";
import { buildUserReport } from "../../src/reporting/user-report.js";
import { taskResult } from "../../src/tasks/result.js";
import { stringify } from "yaml";
import { VERIFIED_CLIENTS } from "../../src/traffic/clients.js";
import { loadMainEnvironment } from "../../src/tasks/environment-state.js";

const dockerTest = test.skipIf(process.env.RELAY_DOCKER_TEST !== "1");
async function command(container: string, text: string) {
  const result = await execute(
    dockerClient(),
    container,
    ["sh", "-c", text],
    {},
    10000,
    4096,
  );
  expect(result.exitCode, result.output).toBe(0);
}

// 真实宿主文件、Docker绑定挂载与MCP入口，不调用模型接口。
dockerTest(
  "显式隔离保留原项目，默认直接任务即时写入、事后检查、收尾不回写或删原项目",
  async () => {
    const f = await policyFixture({ projectMode: "isolated" });
    try {
      await writeFile(join(f.project, "value"), "original");
      const isolated = await f.create();
      expect(isolated.projectMode).toBe("isolated");
      await command(isolated.containerId!, "printf sandbox > value");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("original");
      await f.tool("cleanup_task", { id: isolated.id });

      await rm(join(f.home, "permissions/project.yaml"));
      await writeFile(join(f.directory, "host-only"), "outside-project");
      await symlink(
        join(f.directory, "host-only"),
        join(f.project, "host-link"),
      );
      await writeFile(
        join(f.project, "relay-sandbox.yaml"),
        stringify({
          delivery: {
            aiReview: false,
            checks: [
              {
                name: "isolated-check",
                argv: [
                  "sh",
                  "-c",
                  'test "$(cat value)" = changed && printf check-only > value',
                ],
              },
            ],
          },
        }),
      );
      const task = await f.create();
      expect(task.projectMode).toBe("direct");
      const info = await dockerClient()
        .getContainer(task.containerId!)
        .inspect();
      expect(info.Mounts).toContainEqual(
        expect.objectContaining({
          Type: "bind",
          Source: f.project,
          Destination: "/workspace",
          RW: true,
        }),
      );
      await command(
        task.containerId!,
        "test ! -e host-link && printf changed > value && printf created > new-file",
      );
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("changed");
      expect(
        (await buildUserReport(f.home, task.id)).originalProjectChangedByTask,
      ).toBeNull();
      await collectTask(f.home, task);
      await f.permissions({ project: { mode: "isolated" } });
      const prepared = await prepareDelivery(f.home, task.id);
      expect(prepared.task.state).toBe("ready");
      expect(prepared.task.checks[0]?.status).toBe("passed");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("changed");
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
      const result = await taskResult(f.home, task.id);
      expect(result.applicationPlan?.kind).toBe("post_write_changes");
      expect(
        result.applicationPlan?.changes.some((c) => c.path === "value"),
      ).toBe(true);
      await f.tool("apply_task", { id: task.id });
      expect((await buildUserReport(f.home, task.id)).userMessage).toContain(
        "事后检查已通过",
      );
      expect(
        (await readdir(taskPath(f.home, task.id))).includes("backup"),
      ).toBe(false);
      await f.tool("cleanup_task", { id: task.id });
      expect(await readFile(join(f.project, "new-file"), "utf8")).toBe(
        "created",
      );
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("changed");
    } finally {
      await f.finish();
    }
  },
  120000,
);

// 原项目在审核后再次变化，不能拿旧审核确认通过，也不能覆盖宿主新内容。
dockerTest(
  "直接模式拒绝过期确认，恢复和返工沿用冻结挂载",
  async () => {
    const f = await policyFixture({ projectMode: "isolated" });
    try {
      await f.permissions({
        project: { mode: "direct" },
        decoys: { enabled: true, clients: VERIFIED_CLIENTS },
      });
      await writeFile(join(f.project, "value"), "initial");
      const task = await f.create();
      const initial = await loadMainEnvironment(f.home, task.id);
      expect(initial?.summary.traffic).toBe("ready");
      await command(task.containerId!, "printf result > value");
      await collectTask(f.home, task);
      await prepareDelivery(f.home, task.id);
      await writeFile(join(f.project, "value"), "host-later");
      await expect(applyTask(f.home, task.id)).rejects.toThrow("偏离检查候选");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe(
        "host-later",
      );
      await f.permissions({ project: { mode: "isolated" } });
      await resumeTask(f.home, task.id);
      await command(task.containerId!, "printf resumed > value");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("resumed");
      const current = await getTask(f.home, task.id);
      await collectTask(f.home, current);
      await prepareDelivery(f.home, task.id);
      // 返工入口使用相同启动函数，重新安装冻结网络而不更换挂载。
      await startDirectProject(
        f.home,
        current,
        await loadProfile(f.home, "relay-default"),
      );
      const rework = await loadMainEnvironment(f.home, task.id);
      expect(rework?.summary.traffic).toBe("ready");
      expect(rework?.summary.runtimeId).not.toBe(initial?.summary.runtimeId);
      await command(task.containerId!, "printf reworked > value");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("reworked");
      await stopTask(f.home, task.id);
      await rename(f.project, `${f.project}-old`);
      await mkdir(f.project);
      await expect(resumeTask(f.home, task.id)).rejects.toThrow("目录已被替换");
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
    } finally {
      await f.finish();
    }
  },
  120000,
);

// 排除冲突在创建容器前失败；审核拒绝后原项目已变更的事实仍明确上报。
dockerTest(
  "排除规则冲突拒绝创建，审核拒绝不撤销已有直接修改",
  async () => {
    const f = await policyFixture({ projectMode: "isolated" });
    try {
      await f.permissions({ project: { mode: "direct" } });
      await writeFile(
        join(f.project, "relay-sandbox.yaml"),
        stringify({ project: { exclude: [".env"] } }),
      );
      await expect(f.create()).rejects.toThrow();
      const tasks = await f.cli("status");
      expect(tasks[0].containerId).toBeUndefined();
      await writeFile(
        join(f.project, "relay-sandbox.yaml"),
        stringify({ delivery: { aiReview: true } }),
      );
      await writeFile(join(f.project, "value"), "initial");
      const task = await f.create();
      await command(task.containerId!, "printf rejected > value");
      await collectTask(f.home, task);
      const prepared = await prepareDelivery(f.home, task.id);
      await reviewTask(f.home, task.id, {
        schemaVersion: 1,
        taskId: task.id,
        artifactDigest: prepared.task.artifactDigest,
        configDigest: task.configDigest,
        verdict: "reject",
        summary: "合成拒绝",
        findings: [],
      });
      await expect(applyTask(f.home, task.id)).rejects.toThrow(
        "未满足交付条件",
      );
      await f.tool("cleanup_task", { id: task.id });
      const report = await buildUserReport(f.home, task.id);
      expect(report.originalProjectChangedByTask).toBeNull();
      expect(report.userMessage).toContain("事后检查未通过");
      expect(await readFile(join(f.project, "value"), "utf8")).toBe("rejected");
    } finally {
      await f.finish();
    }
  },
  120000,
);

// 校验遇到FIFO也必须先停止写入，不能停在checking并留下后台进程。
dockerTest(
  "直接项目校验失败前停止写入并持久化失败状态",
  async () => {
    const f = await policyFixture({ projectMode: "isolated" });
    try {
      await f.permissions({ project: { mode: "direct" } });
      const task = await f.create();
      await collectTask(f.home, task);
      await startDirectProject(
        f.home,
        task,
        await loadProfile(f.home, "relay-default"),
      );
      await command(task.containerId!, "mkfifo pending.pipe");
      await expect(prepareDelivery(f.home, task.id)).rejects.toThrow(
        "特殊文件",
      );
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
      expect((await getTask(f.home, task.id)).state).toBe("failed");
      await rm(join(f.project, "pending.pipe"));
      await resumeTask(f.home, task.id);
      await command(task.containerId!, "mkfifo pending.pipe");
      await expect(
        collectTask(f.home, await getTask(f.home, task.id)),
      ).rejects.toThrow("特殊文件");
      expect(
        (await dockerClient().getContainer(task.containerId!).inspect()).State
          .Running,
      ).toBe(false);
    } finally {
      await f.finish();
    }
  },
  120000,
);
