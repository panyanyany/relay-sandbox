import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { configDigest as projectDigest } from "../config/load.js";
import { digest } from "../storage/hash.js";
import { validateId } from "../projects/registry.js";
import { loadHostPermissions } from "../permissions/load.js";
import {
  freezePolicy,
  policyDigest,
  readFrozenPolicy,
} from "../permissions/freeze.js";
import { hostPermissionsSchema } from "../permissions/schema.js";
import type { FrozenPolicy, RuntimeOptions } from "../permissions/types.js";
import {
  prepareResources,
  loadPreparedResources,
} from "../resources/prepare.js";
import { taskPath } from "./store.js";

// 准备与事后审查共用冻结摘要契约，不能只计算项目配置而遗漏授权。
export function environmentConfigDigest(
  config: Config,
  policy: FrozenPolicy,
): string {
  return digest(
    JSON.stringify({
      project: projectDigest(config),
      policy: policyDigest(policy),
    }),
  );
}

// 先复用可信冻结记录；修改宿主授权不能改变已有任务，也不能改变审核摘要。
export async function freezeEnvironment(
  home: string,
  taskId: string,
  projectId: string,
  config: Config,
): Promise<{ policy: FrozenPolicy; configDigest: string }> {
  validateId(projectId);
  const existing = await readFrozenPolicy(home, taskId);
  const requests = config.resourceRequests.length
    ? config.resourceRequests
    : undefined;
  const policy =
    existing ??
    (await freezePolicy(
      home,
      taskId,
      await loadHostPermissions(home, projectId, requests),
    ));
  return {
    policy,
    configDigest: environmentConfigDigest(config, policy),
  };
}

// 新任务使用明确冻结授权；缺少快照的旧任务不加载新配置、不扩大原边界。
export async function prepareEnvironment(
  home: string,
  task: { id: string; projectRoot: string },
  policy: FrozenPolicy | undefined,
  reuse: boolean,
  resourceRoot?: string,
): Promise<RuntimeOptions> {
  const root = taskPath(home, task.id);
  if (policy === undefined) return {};
  // 摘要校验同时拒绝未知字段和版本；规范化默认值后再访问授权内容。
  policyDigest(policy);
  const { schemaVersion, ...body } = policy;
  void schemaVersion;
  const checked = hostPermissionsSchema.parse(body);
  const prepare = reuse ? loadPreparedResources : prepareResources;
  const resources = await prepare(
    checked.resources,
    resourceRoot ?? join(root, "resources"),
    [home, task.projectRoot],
  );
  return {
    mounts: resources.mounts,
    network: { mode: "default-open", grants: checked.network.grants },
  };
}
