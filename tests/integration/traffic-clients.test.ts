import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  prepareClientCatalog,
  VERIFIED_CLIENTS,
} from "../../src/traffic/clients.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { dockerClient } from "../../src/docker/client.js";
import { createRuntime, removeRuntime } from "../../src/docker/runtime.js";
import { execute } from "../../src/docker/execute.js";
import { trafficEventSchema } from "../../src/traffic/events.js";
import { configSchema } from "../../src/config/schema.js";
import { ensureDecoyManifest } from "../../src/decoys/manifest.js";
import {
  startTraffic,
  stopTraffic,
  type TrafficHandle,
} from "../../src/traffic/runtime.js";

// 通过真实独立入口验证首个TLS请求、预先直通及真实证书失败，不替换系统工具。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "curl/wget 显式入口兼容且缺口最小化",
  async () => {
    const docker = dockerClient(),
      id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "relay-clients-"));
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
    const runtime = await createRuntime(
      docker,
      id,
      image,
      image,
      configSchema.parse({}),
    );
    const fixtureCode = [
      "from http.server import BaseHTTPRequestHandler,HTTPServer",
      "import ssl,threading,pathlib",
      "class H(BaseHTTPRequestHandler):",
      " def do_POST(self):",
      "  if self.headers.get_all('X-Relay-Sandbox-Invocation'): self.send_error(400);return",
      "  p=pathlib.Path('/tmp/relay-request-count');p.write_text(str(int(p.read_text())+1) if p.exists() else '1')",
      "  self.rfile.read(int(self.headers.get('Content-Length','0')));self.send_response(503 if self.path=='/fail' else 200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'ok')",
      " def log_message(self,*args): pass",
      "threading.Thread(target=HTTPServer(('127.0.0.1',20080),H).serve_forever,daemon=True).start()",
      "s=HTTPServer(('127.0.0.1',20443),H);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain('/fixture/cert.pem','/fixture/key.pem');s.socket=ctx.wrap_socket(s.socket,server_side=True);s.serve_forever()",
    ].join("\n");
    const fixture = await docker.createContainer({
      Image: image,
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
    let traffic: TrafficHandle | null = null;
    const put = (path: string, text: string) =>
      execute(
        docker,
        runtime.containerId,
        [
          "python3",
          "-c",
          "import os,pathlib;pathlib.Path(os.environ['DEST']).write_text(os.environ['CONTENT'])",
        ],
        { DEST: path, CONTENT: text },
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
      const policy = {
        ...hostPermissionsSchema.parse({
          decoys: { enabled: true, clients: VERIFIED_CLIENTS },
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
      expect(traffic !== null).toBe(true);
      const catalog = prepareClientCatalog(
        policy,
        traffic!.endpoint,
        "/tmp/relay-client-ca.pem",
      );
      await put(
        "/tmp/traffic-client.py",
        await readFile("scripts/traffic-client.py", "utf8"),
      );
      await put(
        "/tmp/traffic_context.py",
        await readFile("scripts/traffic_context.py", "utf8"),
      );
      await put("/tmp/clients.json", JSON.stringify(catalog));
      await put("/tmp/relay-client-ca.pem", traffic!.caCertificate.toString());
      await put(
        "/tmp/fixture-ca.pem",
        await readFile(join(directory, "cert.pem"), "utf8"),
      );
      const invoke = (
        tool: string,
        extra: string[] = [],
        url = "https://127.0.0.1:20443",
      ) =>
        execute(
          docker,
          runtime.containerId,
          [
            "python3",
            "/tmp/traffic-client.py",
            "/tmp/clients.json",
            tool,
            ...(tool === "curl"
              ? [
                  "--disable",
                  "--fail",
                  "--silent",
                  "--show-error",
                  "--max-time",
                  "6",
                  "--data-binary",
                  manifest.entries[0]!.value,
                ]
              : [
                  "--no-config",
                  "--tries",
                  "1",
                  "--timeout",
                  "6",
                  "--quiet",
                  "--output-document",
                  "-",
                  "--post-data",
                  manifest.entries[0]!.value,
                ]),
            ...extra,
            url,
          ],
          {},
          15000,
          4096,
        );
      await put("/home/node/.curlrc", "# caller-owned config\n");
      await put("/home/node/.wgetrc", "# caller-owned config\n");
      for (const tool of ["curl", "wget"]) {
        const beforeEvents = await readFile(traffic!.eventsPath, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        const result = await invoke(tool);
        expect(result.exitCode, tool).toBe(0);
        expect(result.output === "ok").toBe(true);
        expect(
          (await readFile(traffic!.eventsPath, "utf8")).length >
            beforeEvents.length,
        ).toBe(true);
        expect(
          (await readFile(traffic!.eventsPath, "utf8")).includes(
            '"decoyId":"aws-01"',
          ),
        ).toBe(true);
        const added = (await readFile(traffic!.eventsPath, "utf8"))
          .slice(beforeEvents.length)
          .trim()
          .split("\n")
          .map((line) => trafficEventSchema.parse(JSON.parse(line)));
        expect(added.every((event) => event.invocation?.tool === tool)).toBe(
          true,
        );
        expect(
          new Set(added.map((event) => event.invocation?.invocationId)).size,
        ).toBe(1);
        expect(
          new Set(added.map((event) => event.invocation?.requestId)).size,
        ).toBe(1);
        expect(added[0]?.invocation?.source).toBe("client-reported");
        const unknown = await invoke(tool, [
          tool === "curl" ? "--cacert" : "--ca-certificate",
          "/tmp/fixture-ca.pem",
        ]);
        expect(unknown.exitCode === 0).toBe(true);
        expect(
          unknown.output.includes('"reason":"unsupported-arguments"'),
        ).toBe(true);
        const badCertificate = await invoke(
          tool,
          [],
          "https://localhost:20443",
        );
        expect(badCertificate.exitCode !== 0).toBe(true);
      }
      const count = async () =>
        Number(
          (
            await execute(
              docker,
              fixture.id,
              ["cat", "/tmp/relay-request-count"],
              {},
              5000,
              4096,
            )
          ).output,
        );
      const before = await count();
      expect(
        (await invoke("curl", [], "https://127.0.0.1:20443/fail")).exitCode !==
          0,
      ).toBe(true);
      expect((await count()) - before).toBe(1);
      await put("/tmp/clients.json", "{");
      const unavailable = await invoke("curl", [], "http://127.0.0.1:20080");
      expect(unavailable.exitCode).toBe(0);
      expect(
        unavailable.output.includes('"reason":"catalog-unavailable"'),
      ).toBe(true);
      const outdated = {
        ...catalog,
        clients: catalog.clients.map((client) => ({
          ...client,
          version: "0.0.0",
        })),
      };
      await put("/tmp/clients.json", JSON.stringify(outdated));
      const versionGap = await invoke("curl", [
        "--cacert",
        "/tmp/fixture-ca.pem",
      ]);
      expect(versionGap.exitCode === 0).toBe(true);
      expect(versionGap.output.includes('"reason":"unverified-version"')).toBe(
        true,
      );
      await put("/tmp/clients.json", JSON.stringify(catalog));
      await stopTraffic(docker, traffic!);
      traffic = null;
      for (const tool of ["curl", "wget"]) {
        const down = await invoke(tool, [], "http://127.0.0.1:20080");
        expect(down.exitCode === 0).toBe(true);
        expect(down.output.includes('"reason":"proxy-unavailable"')).toBe(true);
        expect(down.output.includes(manifest.entries[0]!.value)).toBe(false);
      }
      const preserved = await execute(
        docker,
        runtime.containerId,
        [
          "python3",
          "-c",
          "from pathlib import Path;print(all(Path('/home/node/'+n).read_text()=='# caller-owned config\\n' for n in ['.curlrc','.wgetrc']))",
        ],
        {},
        5000,
        4096,
      );
      expect(preserved.output.trim()).toBe("True");
      const inspect = await docker.getContainer(runtime.containerId).inspect();
      expect(
        inspect.Config.Env?.some((value) =>
          /^(https?_proxy|HTTPS?_PROXY)=/.test(value),
        ),
      ).toBe(false);
    } finally {
      if (traffic) await stopTraffic(docker, traffic);
      await fixture.remove({ force: true });
      await removeRuntime(docker, runtime);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
