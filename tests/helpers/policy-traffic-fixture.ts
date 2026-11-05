import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { policyFixture } from "./policy-fixture.js";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { VERIFIED_CLIENTS } from "../../src/traffic/clients.js";
import {
  loadMainEnvironment,
  saveEnvironmentState,
} from "../../src/tasks/environment-state.js";

// 自有TLS服务和CA只存在于临时夹具；产品不提供放宽上游TLS验证的开关。
export async function policyTrafficFixture() {
  const fixture = await policyFixture({ projectMode: "isolated" }),
    docker = dockerClient();
  try {
    const directory = join(fixture.directory, "tls");
    await mkdir(directory);
    const command = promisify(execFile);
    for (const name of ["good", "bad"])
      await command(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, `${name}.key`),
          "-out",
          join(directory, `${name}.pem`),
          "-subj",
          "/CN=relay-fixture",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-days",
          "1",
        ],
        { maxBuffer: 65536 },
      );
    await fixture.permissions({
      project: { mode: "isolated" },
      decoys: { enabled: true, clients: VERIFIED_CLIENTS },
    });
    const task = await fixture.create();
    const state = await loadMainEnvironment(fixture.home, task.id);
    if (!state?.handle || !state.summary.helperRoot)
      throw new Error("真实入口未安装通信工具");
    const old = docker.getContainer(state.handle.containerId),
      info = await old.inspect();
    // 测试专用代理克隆继承同一网络命名空间/挂载/权限，仅增加自有上游CA。
    await writeFile(
      join(state.handle.privateDirectory, "ca/upstream.pem"),
      await readFile(join(directory, "good.pem")),
      { mode: 0o600 },
    );
    await old.remove({ force: true });
    const proxy = await docker.createContainer({
      Image: info.Config.Image,
      User: info.Config.User,
      Cmd: [
        ...info.Config.Cmd!,
        "--set",
        "ssl_verify_upstream_trusted_ca=/ca/upstream.pem",
      ],
      Labels: info.Config.Labels,
      HostConfig: {
        NetworkMode: `container:${task.containerId}`,
        Mounts: info.HostConfig.Mounts,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
        LogConfig: { Type: "none", Config: {} },
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=32m" },
      },
    });
    await proxy.start();
    state.handle.containerId = proxy.id;
    await saveEnvironmentState(fixture.home, task.id, state, true);
    const code = [
      "from http.server import BaseHTTPRequestHandler,HTTPServer",
      "import ssl,threading",
      "class H(BaseHTTPRequestHandler):",
      " def do_POST(self):",
      "  self.rfile.read(int(self.headers.get('Content-Length','0')));self.send_response(200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'ok')",
      " def do_GET(self): self.do_POST()",
      " def log_message(self,*args): pass",
      "for port,name in [(18443,'good'),(18444,'bad'),(18081,None)]:",
      " s=HTTPServer(('127.0.0.1',port),H)",
      " if name:",
      "  ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain('/fixture/'+name+'.pem','/fixture/'+name+'.key');s.socket=ctx.wrap_socket(s.socket,server_side=True)",
      " threading.Thread(target=s.serve_forever,daemon=True).start()",
      "threading.Event().wait()",
    ].join("\n");
    const server = await docker.createContainer({
      Image: fixture.image,
      User: "1000:1000",
      Cmd: ["python3", "-c", code],
      Labels: {
        "relay-sandbox.task": task.id,
        "relay-sandbox.kind": "test-endpoint",
      },
      HostConfig: {
        NetworkMode: `container:${task.containerId}`,
        Mounts: [
          {
            Type: "bind",
            Source: directory,
            Target: "/fixture",
            ReadOnly: true,
          },
        ],
        CapDrop: ["ALL"],
      },
    });
    await server.start();
    const run = (argv: string[]) =>
      execute(docker, task.containerId!, argv, {}, 15000, 16384);
    await run([
      "python3",
      "-c",
      "import base64,pathlib,sys;pathlib.Path('/tmp/fixture-ca.pem').write_bytes(base64.b64decode(sys.argv[1]))",
      (await readFile(join(directory, "good.pem"))).toString("base64"),
    ]);
    for (let index = 0; index < 50; index++) {
      const ready = await run([
        "python3",
        "-c",
        "import socket;socket.create_connection(('127.0.0.1',18080),0.2).close();socket.create_connection(('127.0.0.1',18443),0.2).close();socket.create_connection(('127.0.0.1',18081),0.2).close()",
      ]);
      if (ready.exitCode === 0) break;
      if (index === 49) throw new Error("测试代理或上游未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const manifest = JSON.parse(
      await readFile(
        join(fixture.home, "tasks", task.id, "decoys/manifest.json"),
        "utf8",
      ),
    ) as { entries: { value: string }[] };
    return {
      ...fixture,
      task,
      state,
      proxy,
      run,
      values: manifest.entries.map((entry) => entry.value),
      root: state.summary.helperRoot,
      async supervise() {
        await command(
          process.execPath,
          [
            "--import",
            "tsx",
            resolve("src/cli/main.ts"),
            "--home",
            fixture.home,
            "supervise",
            "--once",
          ],
          {
            env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
            timeout: 60000,
            maxBuffer: 65536,
          },
        );
      },
    };
  } catch (error) {
    await fixture.finish();
    throw error;
  }
}
