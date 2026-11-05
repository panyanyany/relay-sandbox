import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { registerProject } from "../../src/projects/registry.js";
import { createIsolatedEphemeralTask as createTask } from "../helpers/ephemeral-task.js";
import { collectTask } from "../../src/tasks/run.js";
import { prepareDelivery } from "../../src/tasks/prepare.js";
import { cleanupTask } from "../../src/tasks/cleanup.js";
import { listTasks, taskPath } from "../../src/tasks/store.js";
import { readFrozenPolicy } from "../../src/permissions/freeze.js";
import { configDigest } from "../../src/config/load.js";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { VERIFIED_CLIENTS } from "../../src/traffic/clients.js";
import {
  listEnvironments,
  loadMainEnvironment,
} from "../../src/tasks/environment-state.js";

// 合成项目与专用模型档案无需真实模型请求，覆盖实际任务创建和候选检查入口。
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "relay-policy-task-"));
  const home = join(directory, "state"),
    project = join(directory, "project");
  await mkdir(project);
  await mkdir(join(home, "profiles"), { recursive: true });
  await mkdir(join(home, "permissions"));
  const image = (
    await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
  ).Id;
  await writeFile(
    join(home, "profiles/relay-default.yaml"),
    stringify({
      endpoint: "https://fixture.invalid/v1",
      model: "fixture",
      protocol: "responses",
      apiKeyEnv: "RELAY_POLICY_FIXTURE_KEY",
      image,
      networkImage: image,
    }),
  );
  await registerProject(home, "project", project);
  process.env.RELAY_POLICY_FIXTURE_KEY = "synthetic-unused-fixture";
  return { directory, home, project };
}
async function finish(home: string, directory: string) {
  for (const task of await listTasks(home)) await cleanupTask(home, task.id);
  delete process.env.RELAY_POLICY_FIXTURE_KEY;
  await rm(directory, { recursive: true, force: true });
}

test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "任务冻结、关闭零辅助资源、授权副本复用与坏配置拒绝",
  async () => {
    const { directory, home, project } = await fixture(),
      docker = dockerClient();
    const source = join(directory, "library");
    await mkdir(source);
    await writeFile(join(source, "value"), "initial-host");
    await writeFile(
      join(project, "relay-sandbox.yaml"),
      stringify({
        delivery: {
          aiReview: false,
          checks: [
            {
              name: "resource",
              argv: [
                "node",
                "-e",
                "if(require('fs').readFileSync('/resources/library/value','utf8')!=='task-copy')process.exit(1)",
              ],
            },
          ],
        },
      }),
    );
    await writeFile(
      join(home, "permissions/project.yaml"),
      stringify({
        resources: [
          {
            name: "library",
            source,
            target: "/resources/library",
            access: "read-write",
          },
        ],
      }),
    );
    try {
      const task = await createTask(home, "project", "合成检查任务");
      const frozen = await readFrozenPolicy(home, task.id);
      expect(frozen?.resources[0]?.source).toBe(source);
      expect(task.configDigest).not.toBe(configDigest(task.config));
      expect(frozen?.decoys.enabled).toBe(false);
      expect((await readdir(taskPath(home, task.id))).includes("traffic")).toBe(
        false,
      );
      expect(
        (
          await docker.listContainers({
            all: true,
            filters: { label: [`relay-sandbox.task=${task.id}`] },
          })
        ).length,
      ).toBe(1);
      expect(
        (
          await execute(
            docker,
            task.containerId!,
            [
              "sh",
              "-c",
              "printf task-copy > /resources/library/value; test ! -e /home/node/.config/relay-sandbox/decoys",
            ],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).toBe(0);
      await writeFile(join(source, "value"), "changed-host");
      await writeFile(
        join(home, "permissions/project.yaml"),
        "privileged: true",
      );
      await collectTask(home, task);
      const checked = await prepareDelivery(home, task.id);
      expect(checked.task.state).toBe("ready");
      expect(checked.task.checks[0]?.status).toBe("passed");
      expect(await readFrozenPolicy(home, task.id)).toEqual(frozen);
      expect(await readFile(join(source, "value"), "utf8")).toBe(
        "changed-host",
      );
      expect(
        (await readdir(join(taskPath(home, task.id), "candidate"))).includes(
          "resources",
        ),
      ).toBe(false);
      await expect(
        createTask(home, "project", "坏授权不派发"),
      ).rejects.toThrow();
      const failed = (await listTasks(home)).find(
        (value) => value.id !== task.id,
      )!;
      expect(failed.state).toBe("failed");
      expect(failed.containerId).toBeUndefined();
    } finally {
      await finish(home, directory);
    }
  },
  120000,
);

test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "创建与最终检查使用冻结诱饵配置，检查代理收尾保留最小记录",
  async () => {
    const { directory, home, project } = await fixture();
    await writeFile(
      join(project, "relay-sandbox.yaml"),
      stringify({
        delivery: {
          aiReview: false,
          checks: [{ name: "pass", argv: ["node", "-e", "process.exit(0)"] }],
        },
      }),
    );
    await writeFile(
      join(home, "permissions/project.yaml"),
      stringify({ decoys: { enabled: true, clients: VERIFIED_CLIENTS } }),
    );
    try {
      const task = await createTask(home, "project", "合成开启诱饵");
      const main = await loadMainEnvironment(home, task.id);
      expect(main?.summary.traffic).toBe("ready");
      await writeFile(
        join(home, "permissions/project.yaml"),
        "decoys:\n  enabled: false\n",
      );
      await collectTask(home, task);
      expect((await prepareDelivery(home, task.id)).task.state).toBe("ready");
      const environments = await listEnvironments(home, task.id);
      const check = environments.find(
        (value) => value.summary.role === "check",
      );
      expect(check?.summary.enabled).toBe(true);
      expect(check?.summary.traffic).toBe("stopped");
      expect(check?.handle).toBeUndefined();
      expect(
        (await loadMainEnvironment(home, task.id))?.summary.runtimeId,
      ).toBe(main?.summary.runtimeId);
      expect(
        environments.filter((value) => value.summary.role === "check"),
      ).toHaveLength(1);
    } finally {
      await finish(home, directory);
    }
  },
  120000,
);
