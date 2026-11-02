import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import { validateId } from "../projects/registry.js";
import { stopTraffic } from "../traffic/runtime.js";
import { randomUUID } from "node:crypto";
import { diagnoseEnvironment } from "./environment-diagnostics.js";
import { taskPath } from "./store.js";
import {
  environmentDirectory,
  loadEnvironmentState,
  saveEnvironmentState,
  type EnvironmentState,
} from "./environment-state.js";

// 不跟随目录链接；未提交summary的半启动目录也保留在固定清理范围内。
async function runtimeDirectories(
  home: string,
  taskId: string,
  errors: Error[],
): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const entry of await readdir(join(taskPath(home, taskId), "traffic"), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) {
        errors.push(new Error("运行时目录不能是链接"));
        continue;
      }
      if (!entry.isDirectory()) continue;
      try {
        validateId(entry.name);
        names.push(entry.name);
      } catch {
        errors.push(new Error("运行时目录标识无效"));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push(new Error("环境目录无法安全枚举", { cause: error }));
  }
  return names;
}

// 一条记录损坏不阻止其余代理清理；错误不包含原始JSON或私密内容。
async function environmentStates(
  home: string,
  taskId: string,
  errors: Error[],
  damaged?: string[],
) {
  const states: EnvironmentState[] = [];
  const names = await runtimeDirectories(home, taskId, errors);
  for (const name of names) {
    try {
      const state = await loadEnvironmentState(home, taskId, name);
      if (state) states.push(state);
    } catch (error) {
      await diagnoseEnvironment(
        home,
        taskId,
        name,
        "environment-record-invalid",
        error,
      );
      if (damaged) damaged.push(name);
      else
        errors.push(
          new Error("环境记录损坏，其他清理仍会继续", { cause: error }),
        );
    }
  }
  return states;
}

// 元数据损坏时不能据此删除其他任务或开发容器；404属于已删除。
async function ownedProxy(docker: Docker, taskId: string, containerId: string) {
  try {
    const info = await docker.getContainer(containerId).inspect();
    if (
      info.Config.Labels?.["relay-sandbox.task"] !== taskId ||
      info.Config.Labels?.["relay-sandbox.kind"] !== "traffic-proxy"
    )
      throw new Error("代理归属不匹配");
    return info;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
}

// 仅在调用方确认所有代理已移除后调用；保留primary manifest供停止后恢复。
export async function purgeEnvironmentSecrets(
  home: string,
  taskId: string,
): Promise<void> {
  const errors: Error[] = [];
  const results = await Promise.allSettled(
    (await runtimeDirectories(home, taskId, errors)).flatMap((name) => {
      const root = environmentDirectory(home, taskId, name);
      return ["ca", "private"].map((part) =>
        rm(join(root, part), { recursive: true, force: true }),
      );
    }),
  );
  for (const result of results)
    if (result.status === "rejected")
      errors.push(
        new Error("部分环境私密材料回收失败", { cause: result.reason }),
      );
  if (errors.length)
    throw new AggregateError(errors, "部分环境私密材料无法安全回收");
}

// 单环境收尾规则供检查环境与任务生命周期共同使用，不复制状态转换。
export async function stopEnvironment(
  docker: Docker,
  home: string,
  taskId: string,
  state: EnvironmentState,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    if (state.handle) {
      await ownedProxy(docker, taskId, state.handle.containerId);
      await stopTraffic(docker, state.handle);
      delete state.handle;
    }
    if (state.summary.enabled) state.summary.traffic = "stopped";
  } catch (error) {
    state.summary.traffic = "cleanup_pending";
    if (!state.summary.gaps.includes("traffic-cleanup-failed"))
      state.summary.gaps.push("traffic-cleanup-failed");
    await diagnoseEnvironment(
      home,
      taskId,
      state.summary.runtimeId,
      "traffic-cleanup-failed",
      error,
    );
    errors.push(error);
  }
  delete state.summary.helperRoot;
  try {
    if (state.summary.enabled) await saveEnvironmentState(home, taskId, state);
  } catch (error) {
    errors.push(new Error("环境清理结果保存失败", { cause: error }));
  }
  if (errors.length) throw new AggregateError(errors, "代理或私钥清理未完成");
}

// 仅在代理及私密材料均确认回收后隔离坏元数据，保留证据与原运行目录。
async function quarantineRecords(
  home: string,
  taskId: string,
  names: string[],
) {
  for (const name of names) {
    const target = join(
      taskPath(home, taskId),
      "environment-quarantine",
      name,
      randomUUID(),
    );
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const file of ["summary.json", "handle.json"]) {
      try {
        await rename(
          join(environmentDirectory(home, taskId, name), file),
          join(target, file),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

// 所有代理独立尝试；错误示范：损坏记录永远保留在活动路径会让重试永久失败。
export async function stopEnvironments(
  docker: Docker,
  home: string,
  taskId: string,
): Promise<void> {
  const errors: Error[] = [],
    damaged: string[] = [];
  const states = await environmentStates(home, taskId, errors, damaged);
  const handled = new Set<string>();
  let allRemoved = true;
  for (const state of states) {
    if (state.handle) handled.add(state.handle.containerId);
    try {
      await stopEnvironment(docker, home, taskId, state);
    } catch (error) {
      allRemoved = false;
      errors.push(new Error("环境收尾失败", { cause: error }));
    }
  }
  // 无summary/handle的孤儿仍以两个归属标签发现，不影响其他容器。
  try {
    const proxies = await docker.listContainers({
      all: true,
      filters: {
        label: [
          `relay-sandbox.task=${taskId}`,
          "relay-sandbox.kind=traffic-proxy",
        ],
      },
    });
    for (const proxy of proxies) {
      if (handled.has(proxy.Id)) continue;
      try {
        await ownedProxy(docker, taskId, proxy.Id);
        await docker.getContainer(proxy.Id).remove({ force: true, v: true });
      } catch (error) {
        allRemoved = false;
        errors.push(new Error("孤儿代理清理失败", { cause: error }));
      }
    }
  } catch (error) {
    allRemoved = false;
    errors.push(new Error("代理列表无法核对", { cause: error }));
  }
  if (allRemoved) {
    try {
      await purgeEnvironmentSecrets(home, taskId);
    } catch (error) {
      errors.push(new Error("环境私密材料回收失败", { cause: error }));
    }
  }
  if (!errors.length && allRemoved)
    await quarantineRecords(home, taskId, damaged);
  if (errors.length) throw new AggregateError(errors, "环境停止或收尾不完整");
}

// 内容观察退出只降级审计，不停止普通开发或放宽强制网络边界。
export async function refreshEnvironments(
  docker: Docker,
  home: string,
  taskId: string,
): Promise<void> {
  const errors: Error[] = [];
  for (const state of await environmentStates(home, taskId, errors)) {
    if (state.summary.traffic !== "ready") continue;
    try {
      if (
        state.handle &&
        (await ownedProxy(docker, taskId, state.handle.containerId))?.State
          .Running
      )
        continue;
      state.summary.traffic = "unavailable";
      delete state.summary.helperRoot;
      if (!state.summary.gaps.includes("proxy-unavailable"))
        state.summary.gaps.push("proxy-unavailable");
      if (state.handle) {
        await stopTraffic(docker, state.handle);
        delete state.handle;
      }
    } catch (error) {
      await diagnoseEnvironment(
        home,
        taskId,
        state.summary.runtimeId,
        "traffic-refresh-failed",
        error,
      );
      state.summary.traffic = "cleanup_pending";
      delete state.summary.helperRoot;
      if (!state.summary.gaps.includes("traffic-cleanup-failed"))
        state.summary.gaps.push("traffic-cleanup-failed");
      errors.push(new Error("通信审计状态核对或回收失败", { cause: error }));
    }
    try {
      await saveEnvironmentState(home, taskId, state);
    } catch (error) {
      errors.push(new Error("审计降级结果保存失败", { cause: error }));
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "部分通信审计状态无法确认");
}
