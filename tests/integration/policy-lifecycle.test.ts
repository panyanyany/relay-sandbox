import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { registerProject } from "../../src/projects/registry.js";
import { createTask } from "../../src/tasks/create.js";
import { cleanupTask, stopTask } from "../../src/tasks/cleanup.js";
import { resumeTask, superviseOnce } from "../../src/tasks/recovery.js";
import { collectGarbage } from "../../src/tasks/garbage-collection.js";
import { getTask, listTasks, taskPath } from "../../src/tasks/store.js";
import { loadMainEnvironment } from "../../src/tasks/environment-state.js";

// 只注册合成项目和专用凭据名，不请求真实模型或修改其他任务资源。
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "relay-policy-lifecycle-"));
  const home = join(directory, "state"),
    project = join(directory, "project"),
    source = join(directory, "source");
  await mkdir(project);
  await mkdir(source);
  await mkdir(join(home, "profiles"), { recursive: true });
  await mkdir(join(home, "permissions"));
  await writeFile(join(source, "value"), "user-source");
  const image = (
    await dockerClient().getImage("relay-sandbox-dev:0.1.0").inspect()
  ).Id;
  await writeFile(
    join(home, "profiles/relay-default.yaml"),
    stringify({
      endpoint: "https://fixture.invalid/v1",
      model: "fixture",
      protocol: "responses",
      apiKeyEnv: "RELAY_LIFECYCLE_FIXTURE_KEY",
      image,
      networkImage: image,
    }),
  );
  await registerProject(home, "project", project);
  process.env.RELAY_LIFECYCLE_FIXTURE_KEY = "synthetic-unused";
  return { directory, home, project, source, image };
}
async function finish(home: string, directory: string) {
  for (const task of await listTasks(home)) await cleanupTask(home, task.id);
  delete process.env.RELAY_LIFECYCLE_FIXTURE_KEY;
  await rm(directory, { recursive: true, force: true });
}

test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "审计故障不停止任务，恢复冻结网络和原诱饵",
  async () => {
    const { directory, home } = await fixture(),
      docker = dockerClient();
    const server = createServer((_req, res) => res.end("authorized-host"));
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(
      join(home, "permissions/project.yaml"),
      stringify({
        decoys: { enabled: true },
        network: { grants: [{ target: "198.19.0.0/16", ports: [port] }] },
      }),
    );
    try {
      const task = await createTask(home, "project", "生命周期合成任务");
      const main = (await loadMainEnvironment(home, task.id))!;
      const manifest = await readFile(
        join(taskPath(home, task.id), "decoys/manifest.json"),
        "utf8",
      );
      await docker.getContainer(main.handle!.containerId).stop();
      await superviseOnce(home);
      expect(
        (await docker.getContainer(task.containerId!).inspect()).State.Running,
      ).toBe(true);
      expect((await loadMainEnvironment(home, task.id))?.summary.traffic).toBe(
        "unavailable",
      );
      await stopTask(home, task.id);
      await writeFile(
        join(home, "permissions/project.yaml"),
        "privileged: true",
      );
      const resumed = await resumeTask(home, task.id);
      expect(resumed.state).toBe("preparing");
      const current = (await loadMainEnvironment(home, task.id))!;
      expect(current.summary.runtimeId === main.summary.runtimeId).toBe(false);
      expect(current.summary.traffic).toBe("ready");
      expect(
        (await readFile(
          join(taskPath(home, task.id), "decoys/manifest.json"),
          "utf8",
        )) === manifest,
      ).toBe(true);
      const gateway = (await docker.getNetwork(task.networkId!).inspect()).IPAM!
        .Config![0]!.Gateway;
      const request = await execute(
        docker,
        task.containerId!,
        [
          "curl",
          "--noproxy",
          "*",
          "--max-time",
          "3",
          `http://${gateway}:${port}`,
        ],
        {},
        5000,
        4096,
      );
      expect(request.output).toContain("authorized-host");
      // 不存在的隔离辅助镜像触发真实mandatory安装失败，成功停止后才能标为中断。
      const profilePath = join(taskPath(home, task.id), "profile.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.networkImage = `sha256:${"0".repeat(64)}`;
      await writeFile(profilePath, JSON.stringify(profile));
      await superviseOnce(home);
      const interrupted = await getTask(home, task.id);
      expect(interrupted.state).toBe("interrupted");
      expect(interrupted.warnings).toContain(
        "网络策略刷新失败，已停止整个任务",
      );
      expect(
        (
          await docker.listContainers({
            filters: { label: [`relay-sandbox.task=${task.id}`] },
          })
        ).length,
      ).toBe(0);
    } finally {
      await finish(home, directory);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  120000,
);

test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "清理失败保留副本，重试删除任务资源和过期证据但保留源与备份",
  async () => {
    const { directory, home, source, image } = await fixture(),
      docker = dockerClient();
    await writeFile(
      join(home, "permissions/project.yaml"),
      stringify({
        decoys: { enabled: true },
        resources: [{ name: "library", source, target: "/resources/library" }],
      }),
    );
    let foreign: ReturnType<typeof docker.getContainer> | undefined;
    try {
      const task = await createTask(home, "project", "清理合成任务");
      const root = taskPath(home, task.id),
        environment = (await loadMainEnvironment(home, task.id))!;
      foreign = await docker.createContainer({
        Image: image,
        Cmd: ["sleep", "infinity"],
        Labels: { "relay-sandbox.test": "cleanup-blocker" },
        HostConfig: { NetworkMode: task.networkId },
      });
      await foreign.start();
      await expect(cleanupTask(home, task.id)).rejects.toThrow();
      expect((await getTask(home, task.id)).state === "cleaned").toBe(false);
      await access(join(root, "resources/library/value"));
      await foreign.remove({ force: true });
      foreign = undefined;
      await cleanupTask(home, task.id);
      await expect(access(join(root, "resources"))).rejects.toThrow();
      await expect(access(join(root, "decoys"))).rejects.toThrow();
      const environmentRoot = join(
        root,
        "traffic",
        environment.summary.runtimeId,
      );
      await access(join(environmentRoot, "summary.json"));
      await mkdir(join(environmentRoot, "evidence"), { recursive: true });
      await writeFile(
        join(environmentRoot, "evidence/events.jsonl"),
        '{"decoyId":"aws-01"}\n',
      );
      await mkdir(join(root, "backup"));
      await writeFile(join(root, "backup/file"), "backup");
      const orphan = join(root, "traffic", "orphan-runtime", "evidence");
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, "events.jsonl"), "{}\n");
      await collectGarbage(home, Date.now() + 8 * 86400000);
      await expect(access(orphan)).rejects.toThrow();
      await expect(access(join(environmentRoot, "evidence"))).rejects.toThrow();
      await access(join(environmentRoot, "summary.json"));
      await access(join(root, "backup/file"));
      expect(await readFile(join(source, "value"), "utf8")).toBe("user-source");
    } finally {
      if (foreign) await foreign.remove({ force: true });
      await finish(home, directory);
    }
  },
  120000,
);

// 有效handle指向非代理容器时仍需独立停止主环境，不能假报代理收尾成功。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "停止附属清理失败仍停止主环境且不假报成功",
  async () => {
    const { directory, home } = await fixture(),
      docker = dockerClient();
    await writeFile(
      join(home, "permissions/project.yaml"),
      "decoys:\n  enabled: true\n",
    );
    let path: string | undefined, original: string | undefined;
    try {
      const task = await createTask(home, "project", "停止错误合成任务");
      const main = (await loadMainEnvironment(home, task.id))!;
      path = join(
        taskPath(home, task.id),
        "traffic",
        main.summary.runtimeId,
        "handle.json",
      );
      original = await readFile(path, "utf8");
      await writeFile(
        path,
        JSON.stringify({
          ...JSON.parse(original),
          containerId: task.containerId,
        }),
      );
      await expect(stopTask(home, task.id)).rejects.toThrow();
      expect((await getTask(home, task.id)).state).toBe("preparing");
      expect(
        (await docker.getContainer(task.containerId!).inspect()).State.Running,
      ).toBe(false);
      expect(
        (
          await docker.listContainers({
            filters: { label: [`relay-sandbox.task=${task.id}`] },
          })
        ).length,
      ).toBe(0);
    } finally {
      if (path && original) await writeFile(path, original);
      await finish(home, directory);
    }
  },
  120000,
);

// 真实代理、私密目录与损坏磁盘记录共同验证新恢复路径，不仅验证mock结果。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "坏环境记录不再永久阻止停止和重复清理",
  async () => {
    const { directory, home } = await fixture(),
      docker = dockerClient();
    await writeFile(
      join(home, "permissions/project.yaml"),
      "decoys:\n  enabled: true\n",
    );
    try {
      const task = await createTask(home, "project", "坏记录清理合成任务");
      const main = (await loadMainEnvironment(home, task.id))!;
      const root = taskPath(home, task.id);
      const environment = join(root, "traffic", main.summary.runtimeId);
      await writeFile(join(environment, "summary.json"), "{");
      expect((await stopTask(home, task.id)).state).toBe("stopped");
      expect(
        (await docker.getContainer(task.containerId!).inspect()).State.Running,
      ).toBe(false);
      await expect(
        docker.getContainer(main.handle!.containerId).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(access(join(environment, "private"))).rejects.toThrow();
      await expect(access(join(environment, "ca"))).rejects.toThrow();
      await access(
        join(root, "environment-quarantine", main.summary.runtimeId),
      );
      expect((await cleanupTask(home, task.id)).state).toBe("cleaned");
      expect((await cleanupTask(home, task.id)).state).toBe("cleaned");
    } finally {
      await finish(home, directory);
    }
  },
  120000,
);
