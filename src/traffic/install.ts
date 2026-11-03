import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { validateId } from "../projects/registry.js";

export interface PublicTrafficFile {
  name: string;
  content: Buffer | string;
  mode?: 0o644 | 0o755;
}
const names = new Set([
  "traffic-client.py",
  "traffic-python.py",
  "traffic_context.py",
  "clients.json",
  "ca.pem",
]);
const reasons = new Set([
  "invalid-runtime",
  "invalid-files",
  "invalid-file",
  "size-limit",
  "unsafe-parent",
  "existing-file",
  "invalid-input",
  "installation-io-error",
]);

// 只安装公开工具与公CA，不接受清单/私钥；不变更PATH或系统工具。
export async function installTrafficFiles(
  docker: Docker,
  containerId: string,
  runtimeId: string,
  files: PublicTrafficFile[],
): Promise<string> {
  validateId(runtimeId);
  if (
    !files.length ||
    files.length > 5 ||
    new Set(files.map((file) => file.name)).size !== files.length
  )
    throw new Error("公共工具清单无效");
  const payload = files.map((file) => {
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content);
    if (
      !names.has(file.name) ||
      content.length > 131072 ||
      (file.mode !== undefined && ![0o644, 0o755].includes(file.mode))
    )
      throw new Error("公共工具文件无效或超过容量");
    return {
      name: file.name,
      mode: file.mode ?? 0o644,
      content: content.toString("base64"),
    };
  });
  const serialized = JSON.stringify({ runtimeId, files: payload });
  if (Buffer.byteLength(serialized) > 100000)
    throw new Error("公共工具总载荷超过容量");
  const script = await readFile(
    new URL("../../scripts/traffic-install.py", import.meta.url),
    "utf8",
  );
  if (script.length > 16384) throw new Error("公共工具安装脚本超过容量");
  let result: { ExitCode: number | null; Running: boolean },
    output = "";
  try {
    const operation = await docker.getContainer(containerId).exec({
      Cmd: ["python3", "-c", script, serialized],
      User: "0:0",
      WorkingDir: "/",
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await operation.start({ hijack: true, stdin: false });
    // 复用Docker成熟解帧器，持续排空但只接受有界固定结果。
    const capture = new PassThrough();
    let size = 0;
    capture.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) stream.destroy(new Error("oversized-output"));
      else output += chunk.toString("utf8");
    });
    docker.modem.demuxStream(stream, capture, capture);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    capture.destroy();
    result = await operation.inspect();
  } catch {
    // Docker错误可能包含exec参数，仅向调用方报告固定原因。
    throw new Error("公共工具安装执行失败");
  }
  let parsed: { ok?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new Error("公共工具安装结果无效");
  }
  if (result.Running || result.ExitCode !== 0 || parsed.ok !== true) {
    const reason =
      typeof parsed.reason === "string" && reasons.has(parsed.reason)
        ? parsed.reason
        : "invalid-result";
    throw new Error(`公共工具安装失败：${reason}`);
  }
  return `/opt/relay-sandbox/audit/${runtimeId}`;
}
