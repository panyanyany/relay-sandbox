import Docker from "dockerode";
// 只连接本机 Unix socket，不从任务输入接受任意远端 Docker 地址。
export function dockerClient(timeout?: number): Docker {
  return new Docker({
    socketPath: "/var/run/docker.sock",
    version: "v1.44",
    timeout,
  });
}
