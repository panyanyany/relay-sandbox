import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import { readDevelopmentSession } from "../../terminal/session.js";
import { getTask } from "../../tasks/store.js";
import { requireRuntimeOwner } from "../../environments/ownership.js";
import { writeJson } from "../../storage/files.js";
import { digest } from "../../storage/hash.js";
import { withFinalizer } from "../../storage/finalize.js";
import { redact } from "../../audit/redaction.js";
import type { SessionAudit } from "../audit.js";
import type { DevelopmentSession } from "../schema.js";
import {
  acquireSessionOperation,
  releaseSessionOperation,
  type SessionOperationLease,
} from "../operation.js";
import { readSessionState, updateSessionState } from "../state.js";
import { copyReviewLogs, snapshotReviewCode } from "./snapshot.js";

export interface ReviewEvidence {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  taskId: string;
  evidenceVersion: number;
  configDigest: string;
  codeDigest: string;
  logDigest: string;
  createdAt: string;
  root: string;
  codePath: string;
  behaviorPath: string;
  gaps: string[];
}
export interface ReviewEvidenceOptions {
  docker: Docker;
  audit: Pick<SessionAudit, "snapshot" | "index">;
  secrets?: string[];
}
// 一次审查的全部写入者共同冻结；不能只看主 Agent 是否正在输出。
export async function withReviewEvidence<T>(
  home: string,
  session: DevelopmentSession,
  options: ReviewEvidenceOptions,
  run: (evidence: ReviewEvidence, lease: SessionOperationLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireSessionOperation(home, session.id, "review"),
    paused: string[] = [];
  const docker = options.docker;
  return withFinalizer(
    async () => {
      const stored = await readDevelopmentSession(home, session.id, {
        cwd: session.cwd,
        projectId: session.projectId,
        agent: session.agent,
      });
      if (
        stored.taskId !== session.taskId ||
        stored.environmentId !== session.environmentId
      )
        throw new Error("会话运行环境绑定已变化");
      if (!session.taskId) throw new Error("会话没有审查任务");
      const task = await getTask(home, session.taskId);
      if (
        task.terminalSessionId !== session.id ||
        task.projectId !== session.projectId ||
        task.projectRoot !== session.cwd ||
        (task.environmentId ?? task.id) !== session.environmentId ||
        !task.containerId ||
        !task.environmentReady
      )
        throw new Error("审查任务与会话归属不一致或运行环境未就绪");
      await requireRuntimeOwner(home, task);
      const owners = new Set([
        task.id,
        ...(task.environmentId ? [task.environmentId] : []),
      ]);
      const listed = await docker.listContainers({
        all: true,
        filters: { label: ["relay-sandbox.task"] },
      });
      const ids = [
        ...new Set([task.containerId, ...listed.map((item) => item.Id)]),
      ];
      for (const id of ids) {
        const container = docker.getContainer(id),
          info = await container.inspect();
        const owned = owners.has(
          info.Config.Labels?.["relay-sandbox.task"] ?? "",
        );
        if (id === task.containerId && !owned)
          throw new Error("主容器归属标签与任务不一致");
        if (id === task.containerId && !info.State.Running)
          throw new Error(
            "主开发容器已停止，请先恢复会话或读取已有固定证据补审",
          );
        if (!owned || !info.State.Running || info.State.Paused) continue;
        await container.pause();
        paused.push(id);
      }
      await requireRuntimeOwner(home, task);
      const { evidenceVersion } = await readSessionState(home, session.id),
        id = randomUUID();
      const root = join(
        home,
        "sessions",
        session.id,
        "reviews",
        `v${evidenceVersion}-${id}`,
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      const codePath = join(root, "code"),
        behaviorPath = join(root, "behavior.json"),
        gaps: string[] = [];
      const code = await snapshotReviewCode(home, task, docker, codePath);
      if (code.direct)
        gaps.push(
          "已冻结容器写入者；宿主外部程序仍可修改直接挂载目录，快照检查仅保证复制时一致",
        );
      const report = await options.audit.snapshot();
      gaps.push(...report.gaps.map((value) => redact(value, options.secrets)));
      await writeJson(
        behaviorPath,
        JSON.parse(redact(JSON.stringify(report), options.secrets)) as unknown,
      );
      const logs = await copyReviewLogs(
        home,
        task,
        join(root, "logs"),
        options.secrets ?? [],
        gaps,
      );
      const evidence: ReviewEvidence = {
        schemaVersion: 1,
        id,
        sessionId: session.id,
        taskId: task.id,
        evidenceVersion,
        configDigest: task.configDigest,
        codeDigest: code.codeDigest,
        logDigest: digest(
          logs + redact(JSON.stringify(report), options.secrets),
        ),
        createdAt: new Date().toISOString(),
        root,
        codePath,
        behaviorPath,
        gaps,
      };
      await writeJson(join(root, "code-manifest.json"), code.manifest);
      await writeJson(join(root, "manifest.json"), evidence);
      // 错误示范：此处提前 unpause 会让旧后台子进程写出尚未增加版本的新内容。
      return run(evidence, lease);
    },
    async () => {
      const errors: unknown[] = [];
      for (const id of paused.reverse()) {
        try {
          await docker.getContainer(id).unpause();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        await updateSessionState(home, session.id, lease, {
          phase: "interrupted",
        });
      await withFinalizer(
        async () => {
          if (errors.length)
            throw new AggregateError(errors, "恢复审查冻结失败，会话已中断");
        },
        () => releaseSessionOperation(home, session.id, lease),
      );
    },
  );
}
