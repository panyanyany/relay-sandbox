import type Docker from "dockerode";
import type { z } from "zod";
import type {
  auditedClientSchema,
  fileResourceSchema,
  hostPermissionsSchema,
  networkGrantSchema,
} from "./schema.js";

export type NetworkGrant = z.infer<typeof networkGrantSchema>;
export type FileResource = z.infer<typeof fileResourceSchema>;
export type AuditedClient = z.infer<typeof auditedClientSchema>;
export type HostPermissions = z.infer<typeof hostPermissionsSchema>;

// 快照独立版本化；摘要由冻结器计算，恢复时不重新加载宿主授权。
export interface FrozenPolicy extends HostPermissions {
  schemaVersion: 1;
}

// 只传递已准备的挂载与网络授权，不开放任意 HostConfig 容器选项。
export interface RuntimeOptions {
  mounts?: NonNullable<Docker.HostConfig["Mounts"]>;
  network?: { mode: "legacy" | "default-open"; grants: NetworkGrant[] };
}
