import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { trafficEventSchema } from "../../src/traffic/events.js";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { ensureDecoyManifest } from "../../src/decoys/manifest.js";
import { prepareClientCatalog } from "../../src/traffic/clients.js";
import {
  startTraffic,
  stopTraffic,
  type TrafficHandle,
} from "../../src/traffic/runtime.js";

// Python只验证明确的urllib入口，不代表任意Python程序自动获得内容覆盖。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "urllib真实TLS、直通、证书验证和无重放",
  async () => {
    const docker = dockerClient(),
      id = randomUUID(),
      image = "relay-sandbox-dev:0.1.0";
    const directory = await mkdtemp(join(tmpdir(), "relay-python-client-"));
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
        "/CN=fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "pipe" },
    );
    const runtime = await createRuntime(
      docker,
      id,
      image,
      image,
      configSchema.parse({}),
    );
    const code = [
      "from http.server import BaseHTTPRequestHandler,HTTPServer",
      "import ssl,threading,pathlib",
      "class H(BaseHTTPRequestHandler):",
      " def do_POST(self):",
      "  if self.headers.get_all('X-Relay-Sandbox-Invocation'): self.send_error(400);return",
      "  p=pathlib.Path('/tmp/count');p.write_text(str(int(p.read_text())+1) if p.exists() else '1');self.rfile.read(int(self.headers.get('Content-Length',0)));self.send_response(503 if self.path=='/fail' else 200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'ok')",
      " def log_message(self,*args): pass",
      "threading.Thread(target=HTTPServer(('127.0.0.1',21080),H).serve_forever,daemon=True).start()",
      "s=HTTPServer(('127.0.0.1',21443),H);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain('/fixture/cert.pem','/fixture/key.pem');s.socket=ctx.wrap_socket(s.socket,server_side=True);s.serve_forever()",
    ].join("\n");
    const fixture = await docker.createContainer({
      Image: image,
      Cmd: ["python3", "-c", code],
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
    let traffic: TrafficHandle | null = null;
    const put = (path: string, content: string) =>
      execute(
        docker,
        runtime.containerId,
        [
          "python3",
          "-c",
          "import pathlib,os;pathlib.Path(os.environ['DEST']).write_text(os.environ['CONTENT'])",
        ],
        { DEST: path, CONTENT: content },
        5000,
        4096,
      );
    try {
      await fixture.start();
      const manifest = await ensureDecoyManifest(
        join(directory, "manifest.json"),
        id,
        { enabled: true, clients: [] },
      );
      const client = {
        id: "urllib-3-11-2",
        tool: "python",
        version: "3.11.2",
        library: "urllib.request@3.11.2",
        trustStore: "explicit-ca-file",
        invocation: ["python", "urllib.request"],
      };
      const policy = {
        ...hostPermissionsSchema.parse({
          decoys: { enabled: true, clients: [client] },
        }),
        schemaVersion: 1 as const,
      };
      traffic = await startTraffic(docker, {
        taskId: id,
        developerContainerId: runtime.containerId,
        privateDirectory: join(directory, "traffic"),
        manifest,
        upstreamCaCertificate: await readFile(join(directory, "cert.pem")),
      });
      const catalog = prepareClientCatalog(
        policy,
        traffic!.endpoint,
        "/tmp/python-proxy-ca.pem",
      );
      await put(
        "/tmp/traffic_context.py",
        await readFile("scripts/traffic_context.py", "utf8"),
      );
      await put(
        "/tmp/traffic-python.py",
        await readFile("scripts/traffic-python.py", "utf8"),
      );
      await put("/tmp/python-catalog.json", JSON.stringify(catalog));
      await put("/tmp/python-proxy-ca.pem", traffic!.caCertificate.toString());
      await put(
        "/tmp/python-fixture-ca.pem",
        await readFile(join(directory, "cert.pem"), "utf8"),
      );
      const invoke = (url = "https://127.0.0.1:21443", extra: string[] = []) =>
        execute(
          docker,
          runtime.containerId,
          [
            "python3",
            "/tmp/traffic-python.py",
            "/tmp/python-catalog.json",
            "--method",
            "POST",
            "--data",
            manifest.entries[0]!.value,
            ...extra,
            url,
          ],
          {},
          15000,
          4096,
        );
      const first = await invoke();
      expect(first.exitCode).toBe(0);
      expect(first.output === "ok").toBe(true);
      expect(
        (await readFile(traffic!.eventsPath, "utf8")).includes(
          '"decoyId":"aws-01"',
        ),
      ).toBe(true);
      const firstEvent = trafficEventSchema.parse(
        JSON.parse(
          (await readFile(traffic!.eventsPath, "utf8")).trim().split("\n")[0]!,
        ),
      );
      expect(firstEvent.invocation).toMatchObject({
        tool: "python",
        source: "client-reported",
        pidNamespace: "container",
      });
      expect(firstEvent.invocation?.pid).toBeGreaterThan(0);
      await put("/tmp/python-proxy-ca.pem", "invalid-ca");
      const unavailableCA = await invoke("http://127.0.0.1:21080");
      expect(unavailableCA.exitCode).toBe(0);
      expect(unavailableCA.output.includes('"reason":"ca-unavailable"')).toBe(
        true,
      );
      await put("/tmp/python-proxy-ca.pem", traffic!.caCertificate.toString());
      expect((await invoke("https://localhost:21443")).exitCode !== 0).toBe(
        true,
      );
      const direct = await invoke(undefined, [
        "--ca-file",
        "/tmp/python-fixture-ca.pem",
      ]);
      expect(direct.exitCode).toBe(0);
      expect(direct.output.includes('"reason":"custom-trust"')).toBe(true);
      const count = async () =>
        Number(
          (
            await execute(
              docker,
              fixture.id,
              ["cat", "/tmp/count"],
              {},
              5000,
              4096,
            )
          ).output,
        );
      const before = await count();
      expect(
        (await invoke("https://127.0.0.1:21443/fail")).exitCode !== 0,
      ).toBe(true);
      expect((await count()) - before).toBe(1);
      await put(
        "/tmp/python-catalog.json",
        JSON.stringify({
          ...catalog,
          clients: [{ ...client, version: "0.0.0" }],
        }),
      );
      const unknown = await invoke("http://127.0.0.1:21080");
      expect(unknown.exitCode).toBe(0);
      expect(
        unknown.output.includes('"reason":"unverified-configuration"'),
      ).toBe(true);
      await put("/tmp/python-catalog.json", "{");
      expect(
        (await invoke("http://127.0.0.1:21080")).output.includes(
          '"reason":"catalog-unavailable"',
        ),
      ).toBe(true);
      await put("/tmp/python-catalog.json", JSON.stringify(catalog));
      await stopTraffic(docker, traffic!);
      traffic = null;
      const down = await invoke("http://127.0.0.1:21080");
      expect(down.exitCode).toBe(0);
      expect(down.output.includes('"reason":"proxy-unavailable"')).toBe(true);
      expect((await invoke()).exitCode !== 0).toBe(true);
    } finally {
      if (traffic) await stopTraffic(docker, traffic);
      await fixture.remove({ force: true });
      await removeRuntime(docker, runtime);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
