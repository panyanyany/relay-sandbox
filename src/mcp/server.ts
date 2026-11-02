import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reviewSchema } from "../agents/host/review-schema.js";
import { createTask } from "../tasks/create.js";
import { getTask } from "../tasks/store.js";
import { taskSnapshot, waitTask } from "../tasks/wait.js";
import { mcpCapabilities, serverInstructions } from "./capabilities.js";
import { dispatchTask, dispatchOperation } from "../tasks/dispatch.js";
import { reviewTask, applyTask } from "../tasks/deliver.js";
import { cleanupTask, stopTask } from "../tasks/cleanup.js";
import { redact, formatError } from "../audit/redaction.js";

import { startService } from "../docker/services.js";
import { dockerClient } from "../docker/client.js";
import { resumeTask } from "../tasks/recovery.js";
import { loadAudit } from "../audit/load.js";
import { telemetryStatus } from "../monitoring/status.js";
import { prepareUserReport } from "../reporting/user-report.js";
import { taskResult, readArtifact, deliveryPlanPage } from "../tasks/result.js";
// MCP 仅接收已注册项目与任务标识，不提供任意 shell、挂载或路径参数。
export async function serveMcp(home: string): Promise<void> {
  const server = new McpServer(
    { name: "relay-sandbox", version: "0.1.0" },
    {
      instructions: serverInstructions,
    },
  );
  // 工具错误保留调用栈，同时按 MCP 返回 isError；stdout 始终只有协议消息。
  const text = async (operation: () => Promise<unknown>) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: redact(JSON.stringify(await operation())),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatError(error) }],
      };
    }
  };
  server.registerTool(
    "get_capabilities",
    {
      description:
        "发现已实现工作流、等待方式、事件及用户通知限制；接入后优先调用。",
      inputSchema: {},
    },
    async () => text(async () => mcpCapabilities()),
  );
  server.registerTool(
    "wait_task",
    {
      description:
        "使用 get_task 返回的 revision 等待任务变化，默认25秒、最多55秒。变化或超时返回 task、revision、reason；取消等待不取消任务。",
      inputSchema: {
        id: z.string(),
        afterRevision: z.string().regex(/^[a-f0-9]{64}$/),
        timeoutSeconds: z.number().int().min(1).max(55).default(25),
      },
    },
    async ({ id, afterRevision, timeoutSeconds }, extra) =>
      text(() =>
        waitTask(home, id, afterRevision, timeoutSeconds, extra.signal),
      ),
  );
  server.registerTool(
    "get_delivery_plan",
    {
      description:
        "分页读取宿主应用计划 apply-plan.json，核对变化和绑定摘要。该元数据不在 candidate 项目目录，不能用 read_artifact 读取。",
      inputSchema: {
        id: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ id, offset, limit }) =>
      text(() => deliveryPlanPage(home, id, offset, limit)),
  );
  server.registerTool(
    "get_audit",
    {
      description: "分页读取宿主完整审计事件；get_result 只提供聚合摘要。",
      inputSchema: {
        id: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ id, offset, limit }) =>
      text(async () => {
        const report = await loadAudit(home, id);
        return {
          coverage: report.coverage,
          gaps: report.gaps,
          events: report.events.slice(offset, offset + limit),
          total: report.events.length,
          next: Math.min(report.events.length, offset + limit),
        };
      }),
  );
  server.registerTool(
    "get_telemetry",
    {
      description:
        "读取宿主独立采集器状态及最近 CPU、内存、PID、网络和块 I/O、容器退出/OOM 指标。没有采样或采样失败会明确返回。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => telemetryStatus(home, id)),
  );
  server.registerTool(
    "report_task",
    {
      description:
        "收尾时生成绑定当前事实的用户报告，包含风险、交付、审计缺口和清理状态。清理后调用，并将返回的 reportId、userMessage 原样作为最终用户回复；返回 prepared 不表示已经送达。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => prepareUserReport(home, id)),
  );
  server.registerTool(
    "start_task",
    {
      description:
        "为已注册项目创建隔离任务并冻结宿主授权；项目/MCP不能扩权。只准备环境，随后调用 run_task。",
      inputSchema: { project: z.string(), prompt: z.string().min(1) },
    },
    async ({ project, prompt }) =>
      text(() => createTask(home, project, prompt)),
  );
  server.registerTool(
    "run_task",
    {
      description:
        "派发后台开发或返工，立即返回；用 wait_task 或 get_task 等待。",
      inputSchema: { id: z.string(), prompt: z.string().optional() },
    },
    async ({ id, prompt }) => text(() => dispatchTask(home, id, prompt)),
  );
  server.registerTool(
    "get_task",
    {
      description:
        "立即读取任务状态和 revision 版本游标。preparing 且 round=0 需要 run_task；开发完成后 prepare_delivery，deliveryPrepared=true 后审查。可将游标传给 wait_task。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      text(async () => {
        const snapshot = await taskSnapshot(home, id);
        return {
          ...snapshot.task,
          revision: snapshot.revision,
          nextAction: snapshot.nextAction,
        };
      }),
  );
  server.registerTool(
    "get_result",
    {
      description:
        "读取修改、检查、冻结策略、直接可写宿主影响、最小流量命中和覆盖缺口及审核 Schema，供宿主审查和上报。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => taskResult(home, id)),
  );
  server.registerTool(
    "prepare_delivery",
    {
      description:
        "后台生成最终候选并执行配置的检查和有限返工；派发后等待状态。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => dispatchOperation(home, id, "prepare")),
  );
  server.registerTool(
    "review_task",
    {
      description:
        "提交绑定任务和双摘要的结构化审核；reject 和 needs_attention 阻止已启用审核的交付。",
      inputSchema: z
        .object({ id: z.string(), decision: reviewSchema })
        .strict(),
    },
    async ({ id, decision }) => text(() => reviewTask(home, id, decision)),
  );
  server.registerTool(
    "apply_task",
    {
      description: "在满足冻结的交付策略后应用最终候选。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => applyTask(home, id)),
  );
  server.registerTool(
    "cancel_task",
    {
      description: "停止任务运行环境；与取消 wait_task 等待不同。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => stopTask(home, id)),
  );
  server.registerTool(
    "cleanup_task",
    {
      description:
        "清理任务运行资源，保留配置规定的报告及备份；完成后调用 report_task 向用户说明。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => cleanupTask(home, id)),
  );
  server.registerTool(
    "start_service",
    {
      description: "按宿主可信模板启动同任务服务。",
      inputSchema: { id: z.string(), profile: z.string() },
    },
    async ({ id, profile }) =>
      text(async () => ({
        containerId: await startService(
          dockerClient(),
          home,
          await getTask(home, id),
          profile,
        ),
      })),
  );
  server.registerTool(
    "resume_task",
    {
      description: "恢复中断任务的文件环境，随后可重新运行；不恢复进程内存。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(() => resumeTask(home, id)),
  );
  server.registerTool(
    "check_candidate",
    {
      description: "后台检查宿主已解决冲突的候选；派发后等待状态。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      text(() => dispatchOperation(home, id, "check-candidate")),
  );
  server.registerTool(
    "read_artifact",
    {
      description:
        "有界读取基线、结果或候选文件，以 base64 返回，支持字节游标。",
      inputSchema: {
        id: z.string(),
        kind: z.enum(["baseline", "result", "candidate"]),
        path: z.string(),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async ({ id, kind, path, offset }) =>
      text(() => readArtifact(home, id, kind, path, offset)),
  );
  await server.connect(new StdioServerTransport());
}
