import { requireWorkspaceUsable } from "../tasks/readiness.js";
import { requireRuntimeOwner } from "../environments/ownership.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type Docker from "dockerode";
import type { Task } from "../tasks/types.js";
const serviceSchema = z
  .object({
    image: z
      .string()
      .regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/),
    argv: z.array(z.string()).min(1),
  })
  .strict();
// 服务模板只从宿主预登记目录读取；共享任务网络命名空间，不发布宿主端口。
export async function startService(
  docker: Docker,
  home: string,
  task: Task,
  profile: string,
): Promise<string> {
  requireWorkspaceUsable(task);
  await requireRuntimeOwner(home, task);
  if (!/^[\w-]+$/.test(profile)) throw new Error("服务档案标识非法");
  if (
    !task.containerId ||
    ["completed", "cleaned", "applying"].includes(task.state)
  )
    throw new Error("任务不允许启动服务");
  const service = serviceSchema.parse(
    parse(await readFile(join(home, "services", `${profile}.yaml`), "utf8")),
  );
  const container = await docker.createContainer({
    Image: service.image,
    Cmd: service.argv,
    User: "1000:1000",
    Labels: {
      "relay-sandbox.task": task.id,
      "relay-sandbox.kind": "service",
      "relay-sandbox.profile": profile,
    },
    HostConfig: {
      NetworkMode: `container:${task.containerId}`,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: task.config.resources.memoryMiB * 1024 * 1024,
      NanoCpus: Math.round(task.config.resources.cpus * 1e9),
      PidsLimit: task.config.resources.pids,
      Init: true,
    },
  });
  try {
    await container.start();
    return container.id;
  } catch (error) {
    try {
      await container.remove({ force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "服务启动与清理均失败", {
        cause: error,
      });
    }
    throw error;
  }
}
