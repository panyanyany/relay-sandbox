import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { redact } from "../audit/redaction.js";
export interface ExecutionResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}
// 有界输出持续排空；超时停止整个容器，避免遗留后台进程。
export async function execute(
  docker: Docker,
  containerId: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  secrets: string[] = [],
  onTimeoutStop?: (stop: () => Promise<unknown>) => Promise<unknown>,
): Promise<ExecutionResult> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: argv,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    User: "1000:1000",
    WorkingDir: "/workspace",
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const output = new PassThrough();
  const collectionLimit =
    maxBytes +
    Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret)));
  let text = "";
  let bytes = 0;
  let truncated = false;
  output.on("data", (chunk: Buffer) => {
    const remaining = Math.max(0, collectionLimit - bytes);
    if (bytes + chunk.length > maxBytes) truncated = true;
    text += chunk.subarray(0, remaining).toString("utf8");
    bytes += chunk.length;
  });
  docker.modem.demuxStream(stream, output, output);
  let timer: NodeJS.Timeout | undefined;
  let timeoutStop: Promise<unknown> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timeoutStop = onTimeoutStop
            ? onTimeoutStop(() => container.stop({ t: 3 }))
            : container.stop({ t: 3 });
          void timeoutStop.then(
            () => reject(new Error("任务执行超时，整个容器已停止")),
            (error) =>
              reject(new Error("任务超时且容器停止失败", { cause: error })),
          );
        }, timeoutMs);
      }),
    ]);
    if (timeoutStop) {
      await timeoutStop;
      throw new Error("任务执行超时，整个容器已停止");
    }
    const result = await exec.inspect();
    if (result.ExitCode === null || result.Running)
      throw new Error("执行结果不明");
    return {
      exitCode: result.ExitCode,
      output: Buffer.from(redact(text, secrets))
        .subarray(0, maxBytes)
        .toString(),
      truncated,
    };
  } finally {
    if (timer) clearTimeout(timer);
    stream.destroy();
    output.destroy();
  }
}
