import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_RECORDS,
  readTrafficEvidence,
} from "../../src/reporting/traffic-evidence.js";
const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-evidence-"));
  roots.push(home);
  const path = join(home, "tasks/task/traffic/main/evidence");
  await mkdir(path, { recursive: true });
  return { home, path };
}
const event = {
  time: "2026-11-02T12:00:00Z",
  host: "example.test",
  port: 443,
  decoyId: "aws",
  encoding: "raw",
  location: "body",
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 持久证据仅接受最小字段；损坏行不进入用户结果。
test("读取轮转最小事件，坏字段和压缩缺口可见", async () => {
  const { home, path } = await fixture();
  await writeFile(join(path, "events.jsonl.1"), JSON.stringify(event) + "\n");
  await writeFile(
    join(path, "events.jsonl"),
    JSON.stringify({ ...event, request: "private" }) + "\n",
  );
  await writeFile(
    join(path, "gaps.jsonl"),
    JSON.stringify({ reason: "size-limit", location: "body" }) + "\n",
  );
  const result = await readTrafficEvidence(home, "task");
  expect(result.events).toEqual([{ ...event, runtimeId: "main" }]);
  expect(result.eventCount).toBe(1);
  expect(result.gaps).toEqual(
    expect.arrayContaining([
      "rotated-evidence",
      "invalid-evidence",
      "size-limit",
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.coverage).toBe("partial");
});
// 链接、超限及缺失不能伪装成完整的零命中结果。
test("拒绝链接与超限文件，区分缺失证据", async () => {
  const { home, path } = await fixture();
  await writeFile(join(home, "outside"), JSON.stringify(event));
  await symlink(join(home, "outside"), join(path, "events.jsonl"));
  await writeFile(join(path, "gaps.jsonl"), "x".repeat(1024 * 1024 + 1));
  const result = await readTrafficEvidence(home, "task");
  expect(result.events).toEqual([]);
  expect(result.gaps).toContain("unreadable-evidence");
  expect(result.gaps).toContain("oversized-evidence");
  expect((await readTrafficEvidence(home, "missing")).coverage).toBe(
    "unavailable",
  );
});

// 实际写盘验证预算截断，不用Redis或测试专用读取器替代产品路径。
test("总字节和解析条数有界，当前主环境优先", async () => {
  const { home, path } = await fixture();
  const root = join(home, "tasks/task/traffic");
  const active = join(root, "zz-current/evidence");
  await mkdir(active, { recursive: true });
  await writeFile(
    join(root, "latest-main.json"),
    JSON.stringify({ runtimeId: "zz-current" }),
  );
  await writeFile(
    join(active, "events.jsonl"),
    JSON.stringify({ ...event, host: "current.test" }) + "\n",
  );
  const record = JSON.stringify(event) + "\n";
  const block = record.repeat(
    Math.floor((1024 * 1024) / Buffer.byteLength(record)),
  );
  for (const suffix of ["", ".1", ".2"])
    await writeFile(join(path, `events.jsonl${suffix}`), block);
  const result = await readTrafficEvidence(home, "task");
  expect(result.events[0]?.host).toBe("current.test");
  expect(result.truncated).toBe(true);
  expect(result.gaps).toContain("evidence-record-budget");
  expect(result.eventCount).toBeLessThanOrEqual(EVIDENCE_MAX_RECORDS);
  // 少量大记录触发字节预算，而不是先触发记录预算。
  await rm(path, { recursive: true });
  await mkdir(path);
  const large = JSON.stringify(event) + " ".repeat(50000) + "\n";
  const bytesBlock = large.repeat(20);
  for (const name of ["a", "b", "c", "d", "e"]) {
    const target = join(root, name, "evidence");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "events.jsonl"), bytesBlock);
  }
  const bounded = await readTrafficEvidence(home, "task");
  expect(bounded.gaps).toContain("evidence-byte-budget");
  expect(bounded.truncated).toBe(true);
  expect(bounded.eventCount).toBeGreaterThan(1);
  expect(bounded.eventCount * Buffer.byteLength(large)).toBeLessThanOrEqual(
    EVIDENCE_MAX_BYTES + Buffer.byteLength(large),
  );
});
