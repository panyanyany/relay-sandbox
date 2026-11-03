#!/usr/bin/env node
import { registerCredentialCommands } from "./credentials.js";
import { readEnvironment } from "../environments/store.js";
import {
  deleteEnvironment,
  stopProjectEnvironment,
} from "../environments/lifecycle.js";
import { Command } from "commander";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { dispatchTask } from "../tasks/dispatch.js";
import { registerProject } from "../projects/registry.js";
import { createTask } from "../tasks/create.js";
import { getTask, taskPath, listTasks } from "../tasks/store.js";
import { runTask } from "../tasks/run.js";
import { checkAndRepair } from "../tasks/check-and-repair.js";
import { reviewTask, applyTask } from "../tasks/deliver.js";
import { cleanupTask, stopTask } from "../tasks/cleanup.js";
import { dockerClient } from "../docker/client.js";
import { redact, formatError } from "../audit/redaction.js";
import { serveMcp } from "../mcp/server.js";

import { startService } from "../docker/services.js";
import { hostConfig } from "../agents/host/config.js";
import { loadConfig, loadProfile } from "../config/load.js";
import { resolveProject } from "../projects/registry.js";
import { supervise } from "../tasks/supervisor.js";
import { resumeTask } from "../tasks/recovery.js";
import { acceptCandidate } from "../tasks/candidate.js";
import { taskResult } from "../tasks/result.js";
import { inspectApplication } from "../delivery/inspect.js";
import {
  collectGarbage,
  garbageCollectionPlan,
} from "../tasks/garbage-collection.js";
import { telemetryStatus } from "../monitoring/status.js";
import { monitorTask } from "../monitoring/monitor.js";
import { prepareUserReport } from "../reporting/user-report.js";
const program = new Command()
  .name("relay-sandbox")
  .description("中转沙箱：隔离开发、检查和受控交付")
  .version("0.1.0")
  .option(
    "--home <path>",
    "宿主私有状态目录",
    join(homedir(), ".local/share/relay-sandbox"),
  );
const home = (): string => resolve(program.opts<{ home: string }>().home);
registerCredentialCommands(program, home);
const show = (value: unknown): void => {
  console.log(redact(JSON.stringify(value, null, 2)));
};
program
  .command("register <id> <path>")
  .description("显式注册宿主项目")
  .action(async (id: string, path: string) => {
    await registerProject(home(), id, path);
    show({ registered: id });
  });
program
  .command("host-config <project>")
  .description("生成所选宿主 Agent 的 MCP 配置")
  .action(async (project: string) => {
    const config = await loadConfig(await resolveProject(home(), project));
    show(
      hostConfig(
        config.hostAgent.type,
        resolve("dist/src/cli/main.js"),
        home(),
        (await loadProfile(home(), config.developmentAgent.profile)).apiKeyEnv,
      ),
    );
  });
// 显式环境管理入口；重置删除旧环境，下次任务再按当前配置建立。
for (const [name, description, operation] of [
  ["environment-status", "查看项目环境状态", readEnvironment],
  ["environment-stop", "停止空闲环境并保留文件", stopProjectEnvironment],
  [
    "environment-reset",
    "删除空闲环境，下次任务从基础镜像重建",
    deleteEnvironment,
  ],
  [
    "environment-delete",
    "删除空闲项目环境，不删除原项目和任务报告",
    deleteEnvironment,
  ],
] as const)
  program
    .command(`${name} <project>`)
    .description(description)
    .action(async (project: string) =>
      show(
        (await operation(home(), project)) ?? {
          projectId: project,
          status: "absent",
        },
      ),
    );
program
  .command("doctor")
  .description("检查运行条件和已知缺口")
  .action(async () => {
    const version = await dockerClient().version();
    show({
      node: process.version,
      docker: version.Version,
      audit: "尝试宿主 bpftrace；仅部分系统调用覆盖",
      permissions:
        "permissions/<projectId>.yaml；仅宿主配置，新任务冻结，恢复沿用",
      trafficAudit:
        "默认关闭；显式受控工具入口，部分覆盖；代理存活须运行supervise刷新",
      diskQuota: "未启用硬配额",
      recovery: "需要独立运行 supervise；恢复使用 resume",
    });
  });
program
  .command("start <project> <prompt>")
  .option("--wait", "等待开发执行结束")
  .description("准备并启动任务")
  .action(
    async (project: string, prompt: string, options: { wait?: boolean }) => {
      const task = await createTask(home(), project, prompt);
      show(task);
      if (options.wait) {
        show(await runTask(home(), task.id));
        return;
      }
      show(await dispatchTask(home(), task.id));
    },
  );
program
  .command("run <id>")
  .description("运行已准备的任务")
  .action(async (id: string) => show(await runTask(home(), id)));
program
  .command("rework <id> <prompt>")
  .description("沿用任务工作区返工")
  .action(async (id: string, prompt: string) =>
    show(await runTask(home(), id, prompt)),
  );
program
  .command("status [id]")
  .action(async (id?: string) =>
    show(id ? await getTask(home(), id) : await listTasks(home())),
  );
program
  .command("logs <id>")
  .option("--round <number>", "开发轮次")
  .option("--offset <number>", "字节游标", "0")
  .action(async (id: string, options: { round?: string; offset: string }) => {
    const task = await getTask(home(), id);
    const round = options.round ? Number(options.round) : task.round;
    const offset = Number(options.offset);
    if (
      !Number.isSafeInteger(round) ||
      round < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("日志游标或轮次非法");
    const data = await readFile(
      join(taskPath(home(), id), `round-${round}.log`),
    );
    const chunk = data.subarray(offset, offset + 65536);
    show({ text: chunk.toString(), next: offset + chunk.length });
  });
program
  .command("result <id>")
  .action(async (id: string) => show(await taskResult(home(), id)));
program
  .command("prepare <id>")
  .description("合并候选并执行配置的检查")
  .action(async (id: string) => show(await checkAndRepair(home(), id)));
program
  .command("check-candidate <id>")
  .description("检查宿主已解决冲突的候选")
  .action(async (id: string) => show(await acceptCandidate(home(), id)));
program
  .command("review <id>")
  .requiredOption("--file <path>", "结构化审核 JSON 文件")
  .action(async (id: string, options: { file: string }) => {
    const decision: unknown = JSON.parse(
      await readFile(resolve(options.file), "utf8"),
    );
    show(await reviewTask(home(), id, decision));
  });
program
  .command("report <id>")
  .description("生成用户上报内容；不等于用户已收到")
  .action(async (id: string) => show(await prepareUserReport(home(), id)));
program
  .command("inspect-apply <id>")
  .action(async (id: string) => show(await inspectApplication(home(), id)));
program
  .command("apply <id>")
  .action(async (id: string) => show(await applyTask(home(), id)));
program
  .command("cancel <id>")
  .action(async (id: string) => show(await stopTask(home(), id)));
program
  .command("cleanup <id>")
  .action(async (id: string) => show(await cleanupTask(home(), id)));
program
  .command("service-start <id> <profile>")
  .action(async (id: string, profile: string) =>
    show({
      containerId: await startService(
        dockerClient(),
        home(),
        await getTask(home(), id),
        profile,
      ),
    }),
  );
program
  .command("resume <id>")
  .action(async (id: string) => show(await resumeTask(home(), id)));
program
  .command("metrics <id>")
  .description("读取宿主最新资源指标")
  .action(async (id: string) => show(await telemetryStatus(home(), id)));
program
  .command("gc")
  .option("--dry-run", "只列出已到期的资源及报告清理计划")
  .description("清理本状态目录已到期的任务资源、日志及报告")
  .action(async (options: { dryRun?: boolean }) =>
    show(
      options.dryRun
        ? await garbageCollectionPlan(home())
        : await collectGarbage(home()),
    ),
  );
program
  .command("monitor <id>")
  .description("宿主独立进程定时记录任务资源指标")
  .action(async (id: string) => monitorTask(home(), id));
program
  .command("supervise")
  .option("--interval <seconds>", "协调间隔，1–60 秒", "5")
  .option("--once", "仅协调一次")
  .action(async (options: { interval: string; once?: boolean }) => {
    const seconds = Number(options.interval);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
      throw new Error("监督间隔须为 1–60 秒");
    await supervise(home(), seconds, options.once);
  });
program
  .command("mcp")
  .description("启动宿主 stdio MCP")
  .action(async () => serveMcp(home()));
// 错误在入口统一报告，保留堆栈，不返回成功或宽松默认值。
await program.parseAsync().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
