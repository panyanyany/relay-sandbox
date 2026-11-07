import { readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { resolveProject } from "../projects/registry.js";
import { loadConfig } from "../config/load.js";
import { readJson } from "../storage/files.js";
import { reserveTask, prepareTask } from "../tasks/create.js";
import { getTask, saveTask } from "../tasks/store.js";
import { dockerClient } from "../docker/client.js";
import { requireRuntimeOwner } from "../environments/ownership.js";
import {
  createDevelopmentSession,
  parseDevelopmentSession,
  readDevelopmentSession,
  bindDevelopmentEnvironment,
  bindDevelopmentTask,
  sessionPath,
} from "../terminal/session.js";
import type { DevelopmentSession } from "./schema.js";
import { withSessionOperation } from "./operation.js";
import { sessionDevelopmentProfile } from "./profile.js";

// 仅匹配显式注册的真实目录；嵌套注册时取最近的项目根，不自动登记新路径。
export async function trustedProject(home: string, cwd: string) {
  const root = await realpath(cwd);
  let entries: string[];
  try {
    entries = await readdir(join(home, "projects"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const matches = [];
  for (const file of entries.filter((name) => name.endsWith(".json"))) {
    const projectId = file.slice(0, -5);
    const projectRoot = await resolveProject(home, projectId);
    const child = relative(projectRoot, root);
    if (
      child === "" ||
      (!isAbsolute(child) && child !== ".." && !child.startsWith("../"))
    )
      matches.push({ projectId, cwd: projectRoot });
  }
  matches.sort((a, b) => b.cwd.length - a.cwd.length);
  if (!matches[0]) throw new Error("当前目录尚未注册，请先初始化中转沙箱项目");
  if (matches[1]?.cwd === matches[0].cwd)
    throw new Error("同一项目目录存在多个注册标识，请先消除歧义");
  return matches[0];
}

// 先返回经过项目授权的外部会话；只读附加不抢正在开发的操作锁。
export async function openDevelopmentSession(
  home: string,
  input: { cwd: string; sessionId?: string },
) {
  const project = await trustedProject(home, input.cwd);
  let session: DevelopmentSession;
  if (input.sessionId) {
    const stored = parseDevelopmentSession(
      await readJson(sessionPath(home, input.sessionId)),
    );
    session = await readDevelopmentSession(home, input.sessionId, {
      ...project,
      agent: stored.agent,
    });
  } else {
    const config = await loadConfig(project.cwd);
    session = await createDevelopmentSession(home, {
      ...project,
      agent: config.developmentAgent.type,
    });
  }
  return session;
}

// 一个会话绑定一个任务；耗时准备由独占 worker 负责。
export async function ensureSessionEnvironment(
  home: string,
  input: { cwd: string; sessionId?: string },
) {
  let session = await openDevelopmentSession(home, input);
  const project = { projectId: session.projectId, cwd: session.cwd };
  const identity = { ...project, agent: session.agent };
  return withSessionOperation(home, session.id, "prepare", async () => {
    session = await readDevelopmentSession(home, session.id, identity);
    let task;
    if (session.taskId) {
      task = await getTask(home, session.taskId);
    } else {
      task = await reserveTask(home, project.projectId, "原生开发会话");
      // 在耗时准备前保存任务归属；失败后保留任务、冻结档案与错误现场。
      session = await bindDevelopmentTask(home, session.id, identity, task.id);
      task.terminalSessionId = session.id;
      await saveTask(home, task);
      if (task.config.developmentAgent.type !== session.agent)
        throw new Error("项目配置在准备期间改变了开发 Agent 身份，请新建会话");
      task = await prepareTask(home, task.id);
    }
    if (
      task.projectId !== session.projectId ||
      task.projectRoot !== session.cwd ||
      task.config.developmentAgent.type !== session.agent
    )
      throw new Error("任务与开发会话身份不一致");
    if (
      !task.environmentReady ||
      !task.containerId ||
      !["prepared", "running"].includes(task.state)
    )
      throw new Error("会话运行环境未就绪，请检查保留的任务诊断，不会自动重建");
    await requireRuntimeOwner(home, task);
    const runtime = await dockerClient()
      .getContainer(task.containerId)
      .inspect();
    if (!runtime.State.Running)
      throw new Error("会话容器未运行，请显式恢复环境");
    session = await bindDevelopmentEnvironment(home, session.id, identity, {
      taskId: task.id,
      environmentId: task.environmentId ?? task.id,
    });
    return { session, task, ...(await sessionDevelopmentProfile(home, task)) };
  });
}
