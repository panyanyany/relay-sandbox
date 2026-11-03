import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { policyFixture } from "../helpers/policy-fixture.js";
import { execute } from "../../src/docker/execute.js";
import { dockerClient } from "../../src/docker/client.js";
import { collectTask } from "../../src/tasks/run.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { applyTask } from "../../src/tasks/deliver.js";
import { cleanupTask, stopTask } from "../../src/tasks/cleanup.js";
import { resumeTask } from "../../src/tasks/recovery.js";
import { getTask } from "../../src/tasks/store.js";
import { readEnvironment } from "../../src/environments/store.js";
import { deleteEnvironment } from "../../src/environments/lifecycle.js";
import {
  collectGarbage,
  garbageCollectionPlan,
} from "../../src/tasks/garbage-collection.js";
import { buildUserReport } from "../../src/reporting/user-report.js";
const dockerTest = test.skipIf(process.env.RELAY_DOCKER_TEST !== "1");
async function command(id: string, script: string) {
  const result = await execute(
    dockerClient(),
    id,
    ["sh", "-c", script],
    {},
    10000,
    4096,
  );
  expect(result.exitCode, result.output).toBe(0);
  return result.output;
}

// 真实容器和MCP创建；安装用户可执行工具模拟软件安装，无需公网或模型接口。
dockerTest(
  "默认项目环境跨任务复用、停止、同步、旧任务清理与显式重置",
  async () => {
    const f = await policyFixture({ persistent: true });
    try {
      await writeFile(join(f.project, "code"), "original");
      const first = await f.create();
      expect(first.config.environment.mode).toBe("persistent");
      await expect(f.create()).rejects.toThrow();
      await command(
        first.containerId!,
        "mkdir -p /home/node/.local/bin cache && printf '#!/bin/sh\necho retained\n' > /home/node/.local/bin/installed-tool && chmod +x /home/node/.local/bin/installed-tool && printf cached > cache/dependency && printf delivered > code && printf generated > generated",
      );
      await collectTask(f.home, first);
      await prepareDelivery(f.home, first.id);
      await applyTask(f.home, first.id);
      expect(
        (await dockerClient().getContainer(first.containerId!).inspect()).State
          .Running,
      ).toBe(false);
      expect(
        (await readEnvironment(f.home, "project"))?.activeTaskId,
      ).toBeUndefined();
      expect((await buildUserReport(f.home, first.id)).userMessage).toContain(
        "已停止并保留",
      );
      await rm(join(f.project, "generated"));
      await writeFile(join(f.project, "new-host-file"), "new input");
      const second = await f.create();
      expect(second.containerId).toBe(first.containerId);
      expect(second.id).not.toBe(first.id);
      expect(
        await command(
          second.containerId!,
          "test ! -e generated && /home/node/.local/bin/installed-tool && cat cache/dependency && cat new-host-file",
        ),
      ).toContain("retained");
      await stopTask(f.home, first.id);
      await cleanupTask(f.home, first.id);
      expect(
        (await dockerClient().getContainer(second.containerId!).inspect()).State
          .Running,
      ).toBe(true);
      await expect(resumeTask(f.home, first.id)).rejects.toThrow();
      await expect(deleteEnvironment(f.home, "project")).rejects.toThrow(
        "占用",
      );
      await cleanupTask(f.home, second.id);
      const future = Date.now() + 365 * 86400000;
      expect(
        (await garbageCollectionPlan(f.home, future)).some(
          (item) => item.action === "delete_environment",
        ),
      ).toBe(false);
      await f.tool("reset_environment", { project: "project" });
      await expect(
        dockerClient().getContainer(first.containerId!).inspect(),
      ).rejects.toThrow();
      const third = await f.create();
      expect(third.containerId).not.toBe(first.containerId);
      await command(
        third.containerId!,
        "test ! -e /home/node/.local/bin/installed-tool",
      );
    } finally {
      await f.finish();
    }
  },
  180000,
);

dockerTest(
  "同步冲突保留现场，授权改变必须重置，TTL只删除空闲环境",
  async () => {
    const f = await policyFixture({ persistent: true });
    try {
      await writeFile(join(f.project, "code"), "one\n");
      const first = await f.create();
      await command(first.containerId!, "printf 'sandbox\n' > code");
      await cleanupTask(f.home, first.id);
      await writeFile(join(f.project, "code"), "host\n");
      await expect(f.create()).rejects.toThrow();
      expect(await readFile(join(f.project, "code"), "utf8")).toBe("host\n");
      for (const task of await f.cli("status"))
        await cleanupTask(f.home, task.id);
      await deleteEnvironment(f.home, "project");
      await writeFile(
        join(f.project, "relay-sandbox.yaml"),
        stringify({
          environment: { mode: "ttl", idleRetentionHours: 0.01 },
          delivery: { aiReview: false },
        }),
      );
      const ttl = await f.create();
      await stopTask(f.home, ttl.id);
      await resumeTask(f.home, ttl.id);
      expect((await getTask(f.home, ttl.id)).state).toBe("prepared");
      await stopTask(f.home, ttl.id);
      await f.permissions({ project: { mode: "direct" } });
      await expect(f.create()).rejects.toThrow();
      const later = Date.now() + 60000;
      expect(await collectGarbage(f.home, later)).toContain(
        "environment-deleted:project",
      );
      expect(await readEnvironment(f.home, "project")).toBeUndefined();
    } finally {
      await f.finish();
    }
  },
  180000,
);

// 直接模式也复用用户工具；诱饵跨任务沿用身份，但证据和证书按任务重新建立。
dockerTest(
  "直接项目复用与历史诱饵观察边界",
  async () => {
    const f = await policyFixture({ persistent: true });
    try {
      await f.permissions({
        project: { mode: "direct" },
        decoys: { enabled: true },
      });
      const first = await f.create();
      await command(
        first.containerId!,
        "printf retained > /home/node/tool-marker && printf first > direct-file",
      );
      const { taskPath } = await import("../../src/tasks/store.js");
      const { loadMainEnvironment } =
        await import("../../src/tasks/environment-state.js");
      const firstAudit = await loadMainEnvironment(f.home, first.id);
      expect(firstAudit?.summary.traffic).toBe("ready");
      const initial = JSON.parse(
        await readFile(
          join(taskPath(f.home, first.id), "decoys/manifest.json"),
          "utf8",
        ),
      );
      await cleanupTask(f.home, first.id);
      const second = await f.create();
      expect(second.containerId).toBe(first.containerId);
      expect(
        await command(
          second.containerId!,
          "cat /home/node/tool-marker && printf second > direct-file",
        ),
      ).toBe("retained");
      expect(await readFile(join(f.project, "direct-file"), "utf8")).toBe(
        "second",
      );
      const inherited = JSON.parse(
        await readFile(
          join(taskPath(f.home, second.id), "decoys/manifest.json"),
          "utf8",
        ),
      );
      expect(inherited.entries).toEqual(initial.entries);
      expect(inherited.taskId).toBe(second.id);
      const current = await loadMainEnvironment(f.home, second.id);
      expect(current?.summary.traffic).toBe("ready");
      expect(current?.summary.gaps).toContain("historical-decoys-unconfirmed");
      expect(current?.handle?.containerId).not.toBe(
        firstAudit?.handle?.containerId,
      );
      const { startService } = await import("../../src/docker/services.js");
      await startService(dockerClient(), f.home, second, "web");
      await command(
        second.containerId!,
        "curl --retry 5 --retry-connrefused --retry-delay 1 --max-time 10 --silent --proxy http://127.0.0.1:18080 --noproxy '' -H 'X-Synthetic-Decoy: '" +
          inherited.entries[0].value +
          " http://127.0.0.1:18091 >/dev/null",
      );
      const events = await readFile(
        join(
          taskPath(f.home, second.id),
          "traffic",
          second.id,
          "evidence/events.jsonl",
        ),
        "utf8",
      );
      expect(events).toContain('"decoyId":"aws-01"');
      expect(events).not.toContain(inherited.entries[0].value);
    } finally {
      await f.finish();
    }
  },
  180000,
);

dockerTest(
  "显式临时模式交付后销毁容器，任务报告和结果仍可读取",
  async () => {
    const f = await policyFixture();
    try {
      const task = await f.create();
      expect(task.config.environment.mode).toBe("ephemeral");
      await command(task.containerId!, "printf temporary > artifact");
      await collectTask(f.home, task);
      await prepareDelivery(f.home, task.id);
      expect((await applyTask(f.home, task.id)).state).toBe("completed");
      await expect(
        dockerClient().getContainer(task.containerId!).inspect(),
      ).rejects.toThrow();
      expect((await buildUserReport(f.home, task.id)).deliveryStatus).toBe(
        "applied",
      );
      expect(await readEnvironment(f.home, "project")).toBeUndefined();
    } finally {
      await f.finish();
    }
  },
  120000,
);

// 开发和检查必须读到同一份资源内容；检查改写只落在独立快照。
dockerTest(
  "持久可写资源进入候选检查，检查写入不污染下轮环境",
  async () => {
    const f = await policyFixture({ persistent: true });
    try {
      const source = join(f.directory, "resource-source");
      await mkdir(source);
      await writeFile(join(source, "data"), "host");
      await f.permissions({
        resources: [
          {
            name: "cache",
            source,
            target: "/resources/cache",
            mode: "copy",
            access: "read-write",
          },
        ],
      });
      await writeFile(
        join(f.project, "relay-sandbox.yaml"),
        stringify({
          delivery: {
            aiReview: false,
            checks: [
              {
                name: "resource-content",
                argv: [
                  "sh",
                  "-c",
                  'test "$(cat /resources/cache/data)" = developed && printf check-mutated > /resources/cache/data',
                ],
              },
            ],
          },
        }),
      );
      const first = await f.create();
      await command(
        first.containerId!,
        "printf developed > /resources/cache/data",
      );
      await collectTask(f.home, first);
      await prepareDelivery(f.home, first.id);
      expect((await getTask(f.home, first.id)).checks[0]?.status).toBe(
        "passed",
      );
      await applyTask(f.home, first.id);
      const second = await f.create();
      expect(
        await command(second.containerId!, "cat /resources/cache/data"),
      ).toContain("developed");
      expect(await readFile(join(source, "data"), "utf8")).toBe("host");
    } finally {
      await f.finish();
    }
  },
  120000,
);
