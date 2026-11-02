import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { configSchema } from "../../src/config/schema.js";
import { ensureDecoyManifest } from "../../src/decoys/manifest.js";
import {
  startTraffic,
  stopTraffic,
  type TrafficHandle,
} from "../../src/traffic/runtime.js";

// 专用本地TLS端点提供成功与失败对照，不依赖公网证书网站可用性。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "真实代理证据、TLS验证、轮转及宿主隔离",
  async () => {
    execFileSync(
      "docker",
      [
        "build",
        "-q",
        "-f",
        "images/traffic.Dockerfile",
        "-t",
        "relay-sandbox-traffic:0.1.0",
        ".",
      ],
      { timeout: 120000, stdio: "pipe" },
    );
    const docker = dockerClient(),
      id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "relay-traffic-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-subj",
        "/CN=relay-fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "pipe" },
    );
    const image = "relay-sandbox-dev:0.1.0";
    const host = createServer((_req, res) => res.end("host-only"));
    await new Promise<void>((resolve) => host.listen(0, "0.0.0.0", resolve));
    const hostPort = (host.address() as { port: number }).port;
    const runtime = await createRuntime(
      docker,
      id,
      image,
      image,
      configSchema.parse({}),
      id,
      { network: { mode: "default-open", grants: [] } },
    );
    let traffic: TrafficHandle | null = null;
    const fixtureCode = [
      "from http.server import BaseHTTPRequestHandler,HTTPServer",
      "import ssl,threading",
      "class H(BaseHTTPRequestHandler):",
      " def do_POST(self):",
      "  self.rfile.read(int(self.headers.get('Content-Length','0')));self.send_response(200);self.end_headers();self.wfile.write(b'ok')",
      " def log_message(self,*args): pass",
      "threading.Thread(target=HTTPServer(('127.0.0.1',18081),H).serve_forever,daemon=True).start()",
      "server=HTTPServer(('127.0.0.1',18082),H)",
      "ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain('/fixture/cert.pem','/fixture/key.pem')",
      "server.socket=ctx.wrap_socket(server.socket,server_side=True);server.serve_forever()",
    ].join("\n");
    const fixture = await docker.createContainer({
      Image: image,
      User: "0:0",
      Cmd: ["python3", "-c", fixtureCode],
      HostConfig: {
        NetworkMode: `container:${runtime.containerId}`,
        Mounts: [
          {
            Type: "bind",
            Source: directory,
            Target: "/fixture",
            ReadOnly: true,
          },
        ],
      },
      Labels: { "relay-sandbox.task": id },
    });
    try {
      await fixture.start();
      const manifest = await ensureDecoyManifest(
        join(directory, "manifest-source.json"),
        id,
        { enabled: true, clients: [] },
      );
      // 专用短诱饵用于合法DNS标签中的写盘脱敏，不使用真实凭据。
      manifest.entries[1]!.value = "relay-host-canary";
      const options = {
        taskId: id,
        developerContainerId: runtime.containerId,
        privateDirectory: join(directory, "traffic"),
        manifest,
      };
      traffic = await startTraffic(docker, {
        ...options,
        upstreamCaCertificate: await readFile(join(directory, "cert.pem")),
      });
      expect(traffic).not.toBeNull();
      const installCA = () =>
        execute(
          docker,
          runtime.containerId,
          ["sh", "-c", "printf '%s' \"$CA\" > /tmp/relay-ca.crt"],
          { CA: traffic!.caCertificate.toString() },
          5000,
          4096,
        );
      await installCA();
      const request = (url: string, extra: string[] = []) =>
        execute(
          docker,
          runtime.containerId,
          [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "8",
            "--noproxy",
            "",
            "--proxy",
            traffic!.endpoint,
            "--cacert",
            "/tmp/relay-ca.crt",
            ...extra,
            url,
          ],
          {},
          15000,
          4096,
        );
      const body = ["--data-binary", manifest.entries[0]!.value];
      expect((await request("http://127.0.0.1:18081", body)).output).toBe("ok");
      expect((await request("https://127.0.0.1:18082", body)).output).toBe(
        "ok",
      );
      const gateway = (await docker.getNetwork(runtime.networkId).inspect())
        .IPAM!.Config![0]!.Gateway;
      expect(
        (await request(`http://${gateway}:${hostPort}`)).exitCode,
      ).not.toBe(0);
      expect(
        await execute(
          docker,
          runtime.containerId,
          ["python3", "-c", "open('/tmp/large-body','wb').write(b'x'*2097152)"],
          {},
          5000,
          4096,
        ),
      ).toMatchObject({ exitCode: 0 });
      expect(
        (
          await request("http://127.0.0.1:18081", [
            "--data-binary",
            "@/tmp/large-body",
          ])
        ).exitCode,
      ).toBe(0);
      expect(await readFile(traffic!.gapsPath, "utf8")).toContain("size-limit");
      // 主机字段可能含诱饵，即使上游不可达，观察点证据也必须整字段脱敏。
      await request(`http://${manifest.entries[1]!.value}.invalid`, [
        "-H",
        `X-Decoy: ${manifest.entries[0]!.value}`,
      ]);
      let text = await readFile(traffic!.eventsPath, "utf8");
      expect(text).toContain('"host":"redacted.invalid"');
      expect(text).toContain('"decoyId":"aws-01"');
      expect(text.toLowerCase()).not.toContain(
        manifest.entries[0]!.value.toLowerCase(),
      );
      // 人为填满受控证据文件，后续真实请求必须轮转并保持最多三个文件。
      for (let index = 0; index < 4; index++) {
        await writeFile(traffic!.eventsPath, Buffer.alloc(1048576, 32));
        expect((await request("http://127.0.0.1:18081", body)).exitCode).toBe(
          0,
        );
      }
      expect(
        (await readdir(join(traffic!.privateDirectory, "evidence"))).filter(
          (name) => name.startsWith("events.jsonl"),
        ),
      ).toHaveLength(3);
      text = await readFile(traffic!.eventsPath, "utf8");
      expect(text).toContain("aws-01");
      const inspect = await docker.getContainer(traffic!.containerId).inspect();
      expect(inspect.HostConfig.NetworkMode).toBe(
        `container:${runtime.containerId}`,
      );
      expect(inspect.NetworkSettings.Ports ?? {}).toEqual({});
      expect(inspect.HostConfig.LogConfig?.Type).toBe("none");
      expect(inspect.Config.Labels["relay-sandbox.task"]).toBe(id);
      await stopTraffic(docker, traffic!);
      expect(await readdir(traffic!.privateDirectory)).not.toContain("ca");
      expect(await readFile(traffic!.eventsPath, "utf8")).toContain("aws-01");
      traffic = null;
      // 同一TLS端点去掉可信CA后必须失败，不能偷偷设置ssl_insecure。
      traffic = await startTraffic(docker, {
        ...options,
        privateDirectory: join(directory, "untrusted"),
      });
      await installCA();
      const rejected = await request("https://127.0.0.1:18082", body);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain("502");
    } finally {
      if (traffic) await stopTraffic(docker, traffic);
      await fixture.remove({ force: true });
      await removeRuntime(docker, runtime);
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  },
  180000,
);
