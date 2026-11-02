import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ensureDecoyManifest,
  DECOY_DIRECTORY,
} from "../../src/decoys/manifest.js";
import { installDecoys } from "../../src/decoys/install.js";
import { dockerClient } from "../../src/docker/client.js";
import { execute } from "../../src/docker/execute.js";
// 真实容器检查路径冲突和无覆盖，不在测试输出中打印诱饵值。
test.skipIf(process.env.RELAY_DOCKER_TEST !== "1")(
  "诱饵可选投放、重复与祖先链接均不覆盖",
  async () => {
    const docker = dockerClient();
    const root = await mkdtemp(join(tmpdir(), "relay-decoy-install-"));
    const id = randomUUID();
    const image = (await docker.getImage("relay-sandbox-dev:0.1.0").inspect())
      .Id;
    const container = await docker.createContainer({
      Image: image,
      User: "1000:1000",
      Cmd: ["sleep", "infinity"],
      Labels: { "relay-sandbox.test": id },
      HostConfig: {
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    try {
      await container.start();
      const run = (code: string) =>
        execute(docker, container.id, ["python3", "-c", code], {}, 5000, 4096);
      const disabled = await ensureDecoyManifest(
        join(root, "disabled.json"),
        id,
        { enabled: false, clients: [] },
      );
      expect(await installDecoys(docker, "nonexistent", disabled)).toEqual([]);
      expect(
        (await run(`import os; print(os.path.exists('${DECOY_DIRECTORY}'))`))
          .output,
      ).toBe("False\n");
      await run(
        "import os; os.makedirs('/home/node/.config',exist_ok=True); open('/home/node/.config/existing','w').write('keep')",
      );
      const manifest = await ensureDecoyManifest(
        join(root, "manifest.json"),
        id,
        { enabled: true, clients: [] },
      );
      const summary = await installDecoys(docker, container.id, manifest);
      expect(summary.map((entry) => entry.status)).toEqual([
        "installed",
        "installed",
      ]);
      const check = await run(
        `import json,os; p='${manifest.entries[0]!.path}'; s=os.stat(p); print(s.st_uid,s.st_mode & 511); print(json.load(open(p))['profile'])`,
      );
      expect(check.output).toBe("1000 384\nrelay-sandbox-decoy\n");
      expect(
        (
          await run(
            `import json; print(json.load(open('${manifest.entries[0]!.path}'))['credential'] == '${manifest.entries[0]!.value}')`,
          )
        ).output,
      ).toBe("True\n");
      for (const entry of manifest.entries)
        expect(JSON.stringify(summary).includes(entry.value)).toBe(false);
      await run(
        `open('${manifest.entries[0]!.path}','w').write('keep-decoy-file')`,
      );
      const repeated = await installDecoys(docker, container.id, manifest);
      expect(repeated.every((entry) => entry.status === "skipped")).toBe(true);
      expect(
        (await run(`print(open('${manifest.entries[0]!.path}').read())`))
          .output,
      ).toBe("keep-decoy-file\n");
      await run(
        `import os,shutil; shutil.rmtree('${DECOY_DIRECTORY}'); os.mkdir('/tmp/decoy-target'); os.symlink('/tmp/decoy-target','${DECOY_DIRECTORY}')`,
      );
      expect(
        (await installDecoys(docker, container.id, manifest)).every(
          (entry) => entry.status === "skipped",
        ),
      ).toBe(true);
      expect(
        (
          await run(
            "import os; print(os.listdir('/tmp/decoy-target')); print(open('/home/node/.config/existing').read())",
          )
        ).output,
      ).toBe("[]\nkeep\n");
      await run(
        `import os; os.unlink('${DECOY_DIRECTORY}'); open('${DECOY_DIRECTORY}','w').write('user-config')`,
      );
      expect(
        (await installDecoys(docker, container.id, manifest)).every(
          (entry) => entry.status === "skipped",
        ),
      ).toBe(true);
      expect(
        (await run(`print(open('${DECOY_DIRECTORY}').read())`)).output,
      ).toBe("user-config\n");
    } finally {
      await container.remove({ force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
