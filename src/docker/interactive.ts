import {
  PassThrough,
  type Duplex,
  type Readable,
  type Writable,
} from "node:stream";
import type Docker from "dockerode";
export interface InteractiveExec {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  completion: Promise<number>;
  resize(columns: number, rows: number): Promise<void>;
}
// exec 流归后台所有；前端断开不能结束 stdin 或销毁 hijack 连接。
// 调用方持续排空结构化标准输出与错误流；不要把裸流闲置为客户端所有。
export async function startInteractiveExec(
  docker: Docker,
  input: {
    containerId: string;
    argv: string[];
    env: Record<string, string>;
    tty: boolean;
  },
): Promise<InteractiveExec> {
  const exec = await docker.getContainer(input.containerId).exec({
    Cmd: input.argv,
    Env: Object.entries(input.env).map(([k, v]) => `${k}=${v}`),
    User: "1000:1000",
    WorkingDir: "/workspace",
    Tty: input.tty,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  // 启动也声明 TTY，交由 Docker 返回原始终端流；非 TTY 保持标准解复用。
  const stream = (await exec.start({
    hijack: true,
    stdin: true,
    Tty: input.tty,
  })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (input.tty) stream.on("data", (chunk: Buffer) => stdout.write(chunk));
  else docker.modem.demuxStream(stream, stdout, stderr);
  const completion = new Promise<number>((resolve, reject) => {
    let ended = false;
    stream.once("error", reject);
    stream.once("close", () => {
      if (!ended) reject(new Error("交互执行流提前关闭"));
    });
    stream.once("end", () => {
      ended = true;
      stdout.end();
      stderr.end();
      void exec
        .inspect()
        .then((result) => {
          if (result.Running || result.ExitCode === null)
            throw new Error("交互执行结果不明");
          resolve(result.ExitCode);
        })
        .catch(reject);
    });
  });
  // 使用者可以稍后订阅完成；提前关闭仍保留原始 rejection 供上层检查。
  void completion.catch(() => {});
  return {
    stdin: stream,
    stdout,
    stderr,
    completion,
    async resize(columns, rows) {
      if (
        !Number.isInteger(columns) ||
        !Number.isInteger(rows) ||
        columns < 1 ||
        rows < 1
      )
        throw new Error("终端尺寸必须为正整数");
      if (input.tty) await exec.resize({ w: columns, h: rows });
    },
  };
}
