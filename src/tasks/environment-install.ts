import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import type { FrozenPolicy } from "../permissions/types.js";
import { ensureDecoyManifest } from "../decoys/manifest.js";
import { installDecoys } from "../decoys/install.js";
import {
  startTraffic,
  stopTraffic,
  type TrafficHandle,
} from "../traffic/runtime.js";
import { installTrafficFiles } from "../traffic/install.js";
import { prepareClientCatalog } from "../traffic/clients.js";
import { taskPath } from "./store.js";
import {
  loadMainEnvironment,
  environmentDirectory,
  listEnvironments,
  saveEnvironmentState,
  type EnvironmentState,
} from "./environment-state.js";

import { diagnoseEnvironment } from "./environment-diagnostics.js";

export interface EnvironmentInstallOptions {
  home: string;
  taskId: string;
  runtimeId: string;
  containerId: string;
  policy: FrozenPolicy;
  role?: "main" | "check";
}

// 强制网络在调用前已建立；本模块仅安装可降级的内容审计，不修改隔离规则。
export async function installEnvironment(
  docker: Docker,
  options: EnvironmentInstallOptions,
): Promise<EnvironmentState> {
  const { home, taskId, runtimeId, containerId, policy } = options;
  const directory = environmentDirectory(home, taskId, runtimeId);
  const state: EnvironmentState = {
    summary: {
      schemaVersion: 1,
      runtimeId,
      containerId,
      role: options.role ?? "main",
      enabled: policy.decoys.enabled,
      traffic: "disabled",
      placements: [],
      gaps: [],
    },
  };
  if (!policy.decoys.enabled) return state;
  const summary = state.summary;
  const diagnose = (stage: string, error: unknown) =>
    diagnoseEnvironment(home, taskId, runtimeId, stage, error);
  summary.traffic = "unavailable";
  const finish = async () => {
    await saveEnvironmentState(home, taskId, state, summary.role === "main");
    return state;
  };
  // 持久清单准备失败后，恢复和候选检查也不能另造身份冒充历史覆盖。
  let main;
  try {
    main = await loadMainEnvironment(home, taskId);
  } catch (error) {
    await diagnose("decoy-history-unavailable", error);
    summary.gaps.push("decoy-history-unavailable");
    return finish();
  }
  if (main?.summary.gaps.includes("persistent-audit-unavailable")) {
    summary.gaps.push("persistent-audit-unavailable");
    return finish();
  }
  const decoys = join(taskPath(home, taskId), "decoys");
  let manifest;
  try {
    await mkdir(decoys, { recursive: true, mode: 0o700 });
    manifest = await ensureDecoyManifest(
      join(decoys, "manifest.json"),
      taskId,
      policy.decoys,
    );
  } catch (error) {
    await diagnose("decoy-manifest-failed", error);
    summary.gaps.push("decoy-manifest-failed");
    return finish();
  }
  try {
    summary.placements = await installDecoys(docker, containerId, manifest);
  } catch (error) {
    await diagnose("decoy-install-failed", error);
    summary.gaps.push("decoy-install-failed");
    return finish();
  }
  const installed = new Set(
    summary.placements
      .filter((item) => item.status === "installed")
      .map((item) => item.id),
  );
  // 恢复原容器时保留历史诱饵的匹配能力，不声称文件当前仍存在或未改。
  try {
    for (const previous of await listEnvironments(home, taskId)) {
      if (previous.summary.containerId !== containerId) continue;
      for (const placement of previous.summary.placements) {
        if (placement.status === "installed" && !installed.has(placement.id)) {
          installed.add(placement.id);
          if (!summary.gaps.includes("historical-decoys-unconfirmed"))
            summary.gaps.push("historical-decoys-unconfirmed");
        }
      }
    }
  } catch (error) {
    await diagnose("decoy-history-unavailable", error);
    summary.gaps.push("decoy-history-unavailable");
  }
  if (!installed.size) {
    summary.gaps.push("no-active-decoys");
    return finish();
  }
  let traffic: TrafficHandle | null;
  try {
    traffic = await startTraffic(docker, {
      taskId,
      developerContainerId: containerId,
      privateDirectory: directory,
      manifest: {
        ...manifest,
        entries: manifest.entries.filter((entry) => installed.has(entry.id)),
      },
    });
  } catch (error) {
    await diagnose("traffic-start-failed", error);
    summary.gaps.push("traffic-start-failed");
    if (error instanceof AggregateError) {
      summary.traffic = "cleanup_pending";
      summary.gaps.push("traffic-cleanup-failed");
    }
    return finish();
  }
  if (!traffic) {
    summary.gaps.push("no-active-decoys");
    return finish();
  }
  state.handle = {
    containerId: traffic.containerId,
    privateDirectory: directory,
  };
  try {
    const helperRoot = `/opt/relay-sandbox/audit/${runtimeId}`;
    const catalog = prepareClientCatalog(
      policy,
      traffic.endpoint,
      `${helperRoot}/ca.pem`,
    );
    await installTrafficFiles(docker, containerId, runtimeId, [
      {
        name: "traffic-client.py",
        content: await readFile(
          new URL("../../scripts/traffic-client.py", import.meta.url),
        ),
        mode: 0o755,
      },
      {
        name: "traffic-python.py",
        content: await readFile(
          new URL("../../scripts/traffic-python.py", import.meta.url),
        ),
        mode: 0o755,
      },
      {
        name: "traffic_context.py",
        content: await readFile(
          new URL("../../scripts/traffic_context.py", import.meta.url),
        ),
      },
      { name: "clients.json", content: JSON.stringify(catalog) },
      { name: "ca.pem", content: traffic.caCertificate },
    ]);
    summary.helperRoot = helperRoot;
    summary.traffic = "ready";
    summary.gaps.push("unknown-clients-unobserved");
    if (!policy.decoys.clients.length)
      summary.gaps.push("unconfigured-clients");
  } catch (error) {
    await diagnose("traffic-tools-failed", error);
    summary.gaps.push("traffic-tools-failed");
    try {
      await stopTraffic(docker, traffic);
      delete state.handle;
    } catch (error) {
      await diagnose("traffic-cleanup-failed", error);
      summary.traffic = "cleanup_pending";
      summary.gaps.push("traffic-cleanup-failed");
    }
  }
  return finish();
}
