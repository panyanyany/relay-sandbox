import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { trafficGuidance } from "../../src/traffic/guidance.js";
import {
  saveEnvironmentState,
  type EnvironmentSummary,
} from "../../src/tasks/environment-state.js";
const roots: string[] = [];
async function home() {
  const root = await mkdtemp(join(tmpdir(), "relay-guidance-"));
  roots.push(root);
  return root;
}
function summary(
  runtimeId: string,
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    schemaVersion: 1,
    runtimeId,
    containerId: "container",
    role: "main",
    enabled: true,
    traffic: "ready",
    placements: [
      { id: "sensitive-value", path: "/private-secret", status: "installed" },
    ],
    gaps: ["unknown-clients-unobserved"],
    helperRoot: `/opt/relay-sandbox/audit/${runtimeId}`,
    ...overrides,
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
// 用真实环境状态文件检查主入口选择，不模拟内部加载函数。
test("只使用最新主环境入口，提示明确组合与覆盖边界", async () => {
  const root = await home();
  await saveEnvironmentState(
    root,
    "task",
    { summary: summary("main-one") },
    true,
  );
  let result = await trafficGuidance(root, "task");
  expect(result).toContain(
    "python3 /opt/relay-sandbox/audit/main-one/traffic-client.py",
  );
  expect(result).toContain("curl --disable");
  expect(result).toContain("wget --no-config");
  expect(result).toContain("traffic-python.py");
  expect(result).toContain("--method GET");
  expect(result).toContain("普通");
  expect(result).toContain("覆盖");
  for (const value of ["诱饵", "decoy", "sensitive-value", "private-secret"])
    expect(result.includes(value)).toBe(false);
  await saveEnvironmentState(
    root,
    "task",
    { summary: summary("check-one", { role: "check" }) },
    true,
  );
  expect(await trafficGuidance(root, "task")).toBe(result);
  await saveEnvironmentState(
    root,
    "task",
    { summary: summary("main-two") },
    true,
  );
  result = await trafficGuidance(root, "task");
  expect(result).toContain("/audit/main-two/");
  expect(result).not.toContain("main-one");
});
// 审计关闭、损坏或不可用均不向开发Agent提供失效代理入口。
test("关闭、缺失、不可用和无客户端配置只说明覆盖缺口", async () => {
  const root = await home();
  expect(await trafficGuidance(root, "task")).not.toContain(
    "traffic-client.py",
  );
  for (const traffic of [
    "disabled",
    "unavailable",
    "stopped",
    "cleanup_pending",
  ] as const) {
    await saveEnvironmentState(
      root,
      "task",
      { summary: summary("main", { traffic }) },
      true,
    );
    const result = await trafficGuidance(root, "task");
    expect(result).not.toContain("/audit/");
    expect(result).toContain("普通");
  }
  await saveEnvironmentState(
    root,
    "task",
    { summary: summary("main", { gaps: ["unconfigured-clients"] }) },
    true,
  );
  expect(await trafficGuidance(root, "task")).not.toContain(
    "traffic-client.py",
  );
  await writeFile(
    join(root, "tasks/task/traffic/latest-main.json"),
    "invalid secret-value",
  );
  const result = await trafficGuidance(root, "task");
  expect(result).toContain("不可用");
  expect(result).not.toContain("secret-value");
});
