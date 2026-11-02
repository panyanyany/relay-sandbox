import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { hostPermissionsSchema } from "../../src/permissions/schema.js";
import { freezePolicy } from "../../src/permissions/freeze.js";
import { saveTask } from "../../src/tasks/store.js";
import { buildPolicySummary } from "../../src/reporting/policy-summary.js";
import { buildUserReport } from "../../src/reporting/user-report.js";
import { taskResult } from "../../src/tasks/result.js";
import { saveEnvironmentState } from "../../src/tasks/environment-state.js";
const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-policy-report-"));
  roots.push(home);
  await saveTask(home, {
    id: "task",
    projectId: "project",
    projectRoot: "/unused",
    prompt: "x",
    config: configSchema.parse({ delivery: { aiReview: false } }),
    configDigest: "c",
    applicationStatus: "not_attempted",
    state: "cleaned",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
  });
  return home;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 审计命中仅作事实提醒；未应用项目不等于宿主所有资源未改。
test("报告单列直接写入范围和最小命中，不把运行事件当交付否决", async () => {
  const home = await fixture();
  await freezePolicy(
    home,
    "task",
    hostPermissionsSchema.parse({
      resources: [
        {
          name: "cache",
          source: "/private/source",
          target: "/resources/cache",
          mode: "direct",
          access: "read-write",
        },
      ],
      decoys: { enabled: true },
    }),
  );
  await saveEnvironmentState(
    home,
    "task",
    {
      summary: {
        schemaVersion: 1,
        runtimeId: "main",
        containerId: "container",
        role: "main",
        enabled: true,
        traffic: "stopped",
        placements: [],
        gaps: ["unknown-clients-unobserved"],
      },
    },
    true,
  );
  const evidence = join(home, "tasks/task/traffic/main/evidence");
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, "events.jsonl"),
    JSON.stringify({
      time: "2026-11-02T10:00:00Z",
      host: "example.com",
      port: 443,
      decoyId: "aws-01",
      encoding: "base64",
      location: "body",
    }) + "\n",
  );
  const result = await taskResult(home, "task");
  expect(result).toHaveProperty("policy.directHostWritesPossible", true);
  const report = await buildUserReport(home, "task");
  expect(report.deliveryStatus).toBe("not_applied");
  expect(report.originalProjectChangedByTask).toBe(false);
  expect(report).toHaveProperty("policy.traffic.eventCount", 1);
  expect(report.userMessage).toContain("直接可写");
  expect(report.userMessage).toContain("不经过交付审核");
  expect(report.userMessage).toContain("不等同恶意");
  expect(report.userMessage).toContain("远端");
  expect(JSON.stringify(report)).not.toContain("/private/source");
});
// 无证据、非法JSON、链接和轮转缺口都必须显式，不将空集合解释成安全。
test("legacy、关闭及坏元数据不伪装成已审计安全", async () => {
  const home = await fixture();
  expect(await buildPolicySummary(home, "task")).toHaveProperty(
    "mode",
    "legacy",
  );
  await freezePolicy(home, "task", hostPermissionsSchema.parse({}));
  expect(await buildPolicySummary(home, "task")).toHaveProperty(
    "traffic.coverage",
    "disabled",
  );
  const policy = join(home, "tasks/task/policy.json");
  await writeFile(policy, "invalid private-token");
  let summary = await buildPolicySummary(home, "task");
  expect(summary).toHaveProperty("mode", "unavailable");
  expect(JSON.stringify(summary)).not.toContain("private-token");
  await rm(policy);
  await symlink("/etc/passwd", policy);
  summary = await buildPolicySummary(home, "task");
  expect(summary).toHaveProperty("mode", "unavailable");
  expect(JSON.stringify(summary)).not.toContain("root:");
});

// 三十多个检查环境不能把当前开发环境挤出报告摘要。
test("环境摘要优先包含当前主环境", async () => {
  const home = await fixture();
  for (let i = 0; i < 34; i++) {
    await saveEnvironmentState(home, "task", {
      summary: {
        schemaVersion: 1,
        runtimeId: `check-${i}`,
        containerId: "container",
        role: "check",
        enabled: true,
        traffic: "stopped",
        placements: [],
        gaps: [],
      },
    });
  }
  await saveEnvironmentState(
    home,
    "task",
    {
      summary: {
        schemaVersion: 1,
        runtimeId: "zz-current",
        containerId: "container",
        role: "main",
        enabled: true,
        traffic: "unavailable",
        placements: [],
        gaps: ["proxy-unavailable"],
      },
    },
    true,
  );
  const summary = await buildPolicySummary(home, "task");
  expect(summary.environments).toHaveLength(32);
  expect(summary.environments[0]?.runtimeId).toBe("zz-current");
  expect(summary.traffic.gaps).toContain("proxy-unavailable");
  expect(summary.traffic.gaps).toContain("environment-records-truncated");
});
