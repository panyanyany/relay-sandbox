import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { saveTask } from "../../src/tasks/store.js";
import { writeJson } from "../../src/storage/files.js";
import {
  prepareUserReport,
  recordUserEmission,
} from "../../src/reporting/user-report.js";
import type { Task } from "../../src/tasks/types.js";

// 使用宿主记录构造事实，验证上报不能漏掉独立审计或伪造用户送达。
test("审核通过仍上报敏感访问与覆盖缺口，最终输出才能生成回执", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-user-report-"));
  const task: Task = {
    id: "report",
    projectId: "p",
    projectRoot: "/unused",
    prompt: "x",
    config: configSchema.parse({}),
    configDigest: "c",
    artifactDigest: "a",
    applicationStatus: "not_attempted",
    state: "cleaned",
    createdAt: "",
    updatedAt: "",
    round: 1,
    checks: [],
    warnings: [],
    review: {
      schemaVersion: 1,
      taskId: "report",
      artifactDigest: "a",
      configDigest: "c",
      verdict: "approve",
      summary: "代码符合要求",
      findings: [],
    },
  };
  try {
    await saveTask(home, task);
    await writeJson(join(home, "tasks/report/audit.json"), {
      coverage: "partial",
      gaps: ["未覆盖 getenv"],
      warnings: [],
      events: [
        {
          time: "",
          taskId: "report",
          target: "/home/node/.ssh/decoy",
          action: "open-read",
          result: "success",
          source: "bpftrace",
        },
      ],
    });
    await expect(
      recordUserEmission(home, task.id, {
        reportId: "missing",
        userMessage: "未上报",
      }),
    ).rejects.toThrow();
    await writeJson(join(home, "tasks/report/telemetry/latest.json"), {
      time: "2026-11-02T10:00:00Z",
      containers: [
        {
          id: "dev",
          state: "running",
          running: true,
          oomKilled: false,
          exitCode: 0,
          metrics: { cpuPercent: 1 },
        },
      ],
    });
    await writeJson(join(home, "tasks/report/telemetry/events-status.json"), {
      state: "connected",
      updatedAt: "before",
      lastEvent: null,
      lastIncident: null,
    });
    const report = await prepareUserReport(home, task.id);
    expect(report.emissionStatus).toBe("prepared");
    expect(report.userMessage).toContain(".ssh/decoy");
    expect(report.userMessage).toContain("部分覆盖");
    expect(report.reviewVerdict).toBe("approve");
    await expect(
      recordUserEmission(home, task.id, {
        reportId: report.reportId,
        userMessage: "一切正常",
      }),
    ).rejects.toThrow("不符");
    // 错误示范：普通采样和成功探针的Docker事件不应让已输出快照失效。
    await writeJson(join(home, "tasks/report/telemetry/events-status.json"), {
      state: "connected",
      updatedAt: "after",
      lastEvent: { action: "exec_die", exitCode: 0, containerId: "dev" },
      lastIncident: null,
    });
    await writeJson(join(home, "tasks/report/telemetry/latest.json"), {
      time: "2026-11-02T10:00:05Z",
      containers: [
        {
          id: "dev",
          state: "running",
          running: true,
          oomKilled: false,
          exitCode: 0,
          metrics: { cpuPercent: 80 },
        },
      ],
    });
    expect(
      (
        await recordUserEmission(home, task.id, {
          reportId: report.reportId,
          userMessage: report.userMessage,
        })
      ).status,
    ).toBe("emitted");
    await writeJson(join(home, "tasks/report/telemetry/latest.json"), {
      time: "2026-11-02T10:00:10Z",
      kind: "sampling_error",
      error: "Docker unavailable",
    });
    await expect(
      recordUserEmission(home, task.id, {
        reportId: report.reportId,
        userMessage: report.userMessage,
      }),
    ).rejects.toThrow();
    const latest = await prepareUserReport(home, task.id);
    await expect(
      recordUserEmission(home, task.id, {
        reportId: latest.reportId,
        userMessage: latest.userMessage,
      }),
    ).resolves.toHaveProperty("status", "emitted");
    task.warnings.push("新增异常");
    await saveTask(home, task);
    await expect(
      recordUserEmission(home, task.id, {
        reportId: report.reportId,
        userMessage: report.userMessage,
      }),
    ).rejects.toThrow("过期");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("检查关闭、审计不可用和部分应用都在用户报告中明确体现", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-user-report-"));
  try {
    const task: Task = {
      id: "report",
      projectId: "p",
      projectRoot: "/unused",
      prompt: "x",
      config: configSchema.parse({ delivery: { aiReview: false } }),
      configDigest: "c",
      applicationStatus: "failed",
      state: "failed",
      createdAt: "",
      updatedAt: "",
      round: 1,
      checks: [],
      warnings: [],
    };
    await saveTask(home, task);
    const report = await prepareUserReport(home, task.id);
    expect(report.deliveryStatus).toBe("unknown");
    expect(report.originalProjectChangedByTask).toBeNull();
    expect(report.userMessage).toContain("未执行交付检查");
    expect(report.userMessage).toContain("不可用");
    expect(report.userMessage).toContain("尚不能确认");
    // 首次正常采样也不使“尚无采样”快照过期，容器退出则必须重新报告。
    const sample = {
      time: "2026-11-02T11:00:00Z",
      containers: [
        {
          id: "dev",
          state: "running",
          running: true,
          oomKilled: false,
          exitCode: 0,
        },
      ],
    };
    await writeJson(join(home, "tasks/report/telemetry/latest.json"), sample);
    const emission = {
      reportId: report.reportId,
      userMessage: report.userMessage,
    };
    await expect(
      recordUserEmission(home, task.id, emission),
    ).resolves.toHaveProperty("status", "emitted");
    sample.containers[0]!.running = false;
    sample.containers[0]!.state = "exited";
    await writeJson(join(home, "tasks/report/telemetry/latest.json"), sample);
    await expect(recordUserEmission(home, task.id, emission)).rejects.toThrow(
      "过期",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// 即使容器仍运行，也向用户保留子进程OOM线索及事件流覆盖缺口。
test("用户报告展示历史事件证据与覆盖缺口，不直接归因本轮", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-diagnostic-report-"));
  try {
    const task: Task = {
      id: "report",
      projectId: "p",
      projectRoot: "/unused",
      prompt: "x",
      config: configSchema.parse({}),
      configDigest: "c",
      state: "failed",
      round: 2,
      createdAt: "",
      updatedAt: "",
      checks: [],
      warnings: [],
    };
    await saveTask(home, task);
    await writeJson(join(home, "tasks/report/telemetry/events-status.json"), {
      state: "unavailable",
      updatedAt: "now",
      lastEvent: null,
      lastOom: {
        containerId: "old-container",
        action: "oom",
        time: 100,
        exitCode: null,
      },
      lastGap: { updatedAt: "now", error: "socket closed" },
    });
    const report = await prepareUserReport(home, task.id);
    expect(report.userMessage).toContain("事件=oom");
    expect(report.userMessage).toContain("old-container");
    expect(report.userMessage).toContain("socket closed");
    expect(report.userMessage).toContain("可能为历史记录");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
