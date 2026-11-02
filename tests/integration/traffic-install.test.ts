import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
import { installTrafficFiles } from "../../src/traffic/install.js";

// 真实普通用户只能使用公共工具，安装目录不扩展宿主或系统工具权限。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "公共审计工具独占安装及路径保护",
  async () => {
    const docker = dockerClient(),
      id = randomUUID();
    const container = await docker.createContainer({
      Image: "relay-sandbox-dev:0.1.0",
      User: "1000:1000",
      Cmd: ["sleep", "infinity"],
      Labels: { "relay-sandbox.test": id },
      HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
    });
    await container.start();
    const files = [
      {
        name: "traffic-client.py",
        content: "#!/usr/bin/python3\nprint('public-tool')\n",
        mode: 0o755 as const,
      },
      { name: "clients.json", content: '{"schemaVersion":1}' },
    ];
    try {
      const root = await installTrafficFiles(docker, container.id, id, files);
      expect(root).toBe(`/opt/relay-sandbox/audit/${id}`);
      expect(
        (
          await execute(
            docker,
            container.id,
            [`${root}/traffic-client.py`],
            {},
            5000,
            4096,
          )
        ).output.trim(),
      ).toBe("public-tool");
      expect(
        (
          await execute(
            docker,
            container.id,
            ["cat", `${root}/clients.json`],
            {},
            5000,
            4096,
          )
        ).output,
      ).toBe('{"schemaVersion":1}');
      expect(
        (
          await execute(
            docker,
            container.id,
            [
              "python3",
              "-c",
              `open('${root}/clients.json','w').write('changed')`,
            ],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).not.toBe(0);
      await expect(
        installTrafficFiles(docker, container.id, id, [
          { name: "clients.json", content: "changed" },
        ]),
      ).rejects.toThrow("existing-file");
      expect(
        (
          await execute(
            docker,
            container.id,
            ["cat", `${root}/clients.json`],
            {},
            5000,
            4096,
          )
        ).output,
      ).toBe('{"schemaVersion":1}');
      await expect(
        installTrafficFiles(docker, container.id, "../escape", files),
      ).rejects.toThrow();
      await expect(
        installTrafficFiles(docker, container.id, "valid", [
          { name: "../ca.pem", content: "bad" },
        ]),
      ).rejects.toThrow();
      await expect(
        installTrafficFiles(docker, container.id, "valid", [
          { name: "key.pem", content: "bad" },
        ]),
      ).rejects.toThrow();
      await expect(
        installTrafficFiles(docker, container.id, "valid", [
          files[0]!,
          files[0]!,
        ]),
      ).rejects.toThrow();
      await expect(
        installTrafficFiles(docker, container.id, "valid", [
          { name: "ca.pem", content: Buffer.alloc(131073) },
        ]),
      ).rejects.toThrow();
      // 通过可信root fixture建立链接祖先，确认不会穿透到另一个目录。
      const exec = await container.exec({
        Cmd: [
          "python3",
          "-c",
          "import os;os.symlink('/tmp','/opt/relay-sandbox/audit/linked')",
        ],
        User: "0:0",
        WorkingDir: "/",
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      for await (const chunk of stream) {
        void chunk;
      }
      expect((await exec.inspect()).ExitCode).toBe(0);
      await expect(
        installTrafficFiles(docker, container.id, "linked", files),
      ).rejects.toThrow("unsafe-parent");
      expect(
        (
          await execute(
            docker,
            container.id,
            ["test", "-e", "/tmp/traffic-client.py"],
            {},
            5000,
            4096,
          )
        ).exitCode,
      ).not.toBe(0);
    } finally {
      await container.remove({ force: true, v: true });
    }
  },
  30000,
);
