import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import type { DecoyManifest } from "../decoys/manifest.js";

export interface TrafficHandle {
  containerId: string;
  endpoint: "http://127.0.0.1:18080";
  caCertificate: Buffer;
  privateDirectory: string;
  eventsPath: string;
  gapsPath: string;
}
export interface TrafficOptions {
  taskId: string;
  developerContainerId: string;
  privateDirectory: string;
  manifest: DecoyManifest;
  image?: string;
  upstreamCaCertificate?: Buffer;
}

// 默认关闭零资源；辅助容器与开发端共享网络边界但不共享私密文件系统。
export async function startTraffic(
  docker: Docker,
  options: TrafficOptions,
): Promise<TrafficHandle | null> {
  if (!options.manifest.enabled || options.manifest.entries.length === 0)
    return null;
  if (options.manifest.taskId !== options.taskId)
    throw new Error("代理诱饵清单与任务不一致");
  const directory = options.privateDirectory;
  const secret = join(directory, "private"),
    ca = join(directory, "ca"),
    evidence = join(directory, "evidence");
  for (const path of [directory, secret, ca, evidence])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(secret, "manifest.json"),
    JSON.stringify(options.manifest),
    { mode: 0o600, flag: "wx" },
  );
  if (options.upstreamCaCertificate)
    await writeFile(join(ca, "upstream.pem"), options.upstreamCaCertificate, {
      mode: 0o600,
    });
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      Image: options.image ?? "relay-sandbox-traffic:0.1.0",
      User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Cmd: [
        "-q",
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        "18080",
        "--set",
        "confdir=/ca",
        "--set",
        "connection_strategy=lazy",
        "--set",
        "flow_detail=0",
        "--set",
        "ssl_insecure=false",
        "--set",
        "stream_large_bodies=1m",
        "--set",
        "store_streamed_bodies=false",
        ...(options.upstreamCaCertificate
          ? ["--set", "ssl_verify_upstream_trusted_ca=/ca/upstream.pem"]
          : []),
        "-s",
        "/opt/relay/traffic-addon.py",
      ],
      Labels: {
        "relay-sandbox.task": options.taskId,
        "relay-sandbox.kind": "traffic-proxy",
      },
      HostConfig: {
        NetworkMode: `container:${options.developerContainerId}`,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
        LogConfig: { Type: "none", Config: {} },
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=32m" },
        Mounts: [
          { Type: "bind", Source: secret, Target: "/private", ReadOnly: true },
          { Type: "bind", Source: ca, Target: "/ca" },
          { Type: "bind", Source: evidence, Target: "/evidence" },
        ],
      },
    });
    await container.start();
    // 公CA出现且监听成功才接入客户端；不关闭任何上游证书验证。
    for (let index = 0; index < 100; index++) {
      if (!(await container.inspect()).State.Running)
        throw new Error("通信审计代理启动失败");
      try {
        const certificate = await readFile(join(ca, "mitmproxy-ca-cert.pem"));
        const health = await container.exec({
          Cmd: [
            "python3",
            "-c",
            "import socket;socket.create_connection(('127.0.0.1',18080),1).close()",
          ],
          User: "0:0",
          WorkingDir: "/",
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await health.start({ hijack: true, stdin: false });
        for await (const chunk of stream) {
          void chunk;
        }
        if ((await health.inspect()).ExitCode === 0)
          return {
            containerId: container.id,
            endpoint: "http://127.0.0.1:18080",
            caCertificate: certificate,
            privateDirectory: directory,
            eventsPath: join(evidence, "events.jsonl"),
            gapsPath: join(evidence, "gaps.jsonl"),
          };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("通信审计代理就绪超时");
  } catch (error) {
    // 任何清理失败都明确保留；不让容器删除异常跳过私密材料回收。
    const results = await Promise.allSettled([
      ...(container ? [container.remove({ force: true, v: true })] : []),
      rm(secret, { recursive: true, force: true }),
      rm(ca, { recursive: true, force: true }),
    ]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "代理启动失败且收尾不完整",
        { cause: error },
      );
    throw error;
  }
}

// 清理私钥和匹配原值，最小证据交给既有保留期回收；不触碰开发或宿主授权源。
export async function stopTraffic(
  docker: Docker,
  handle: Pick<TrafficHandle, "containerId" | "privateDirectory">,
): Promise<void> {
  try {
    await docker
      .getContainer(handle.containerId)
      .remove({ force: true, v: true });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  await Promise.all(
    ["private", "ca"].map((name) =>
      rm(join(handle.privateDirectory, name), { recursive: true, force: true }),
    ),
  );
}
