import { posix } from "node:path";
import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
// 仅接受规范的绝对路径；实际链接、重叠和宿主源边界由资源准备阶段检查。
const absolutePath = z
  .string()
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.includes("\r") &&
      posix.normalize(value) === value,
    "资源路径必须是无歧义的绝对路径",
  );
const ports = z.union([
  z.literal("all"),
  z
    .array(z.number().int().min(1).max(65535))
    .min(1)
    .refine((values) => new Set(values).size === values.length, "端口不可重复"),
]);
// 地址和 CIDR 使用成熟校验器，后续生成规则时不接受原始脚本文本。
export const networkGrantSchema = z
  .object({
    target: z.union([z.ipv4(), z.cidrv4()]),
    ports,
    protocol: z.enum(["tcp", "udp", "any"]).default("tcp"),
  })
  .strict()
  .refine(
    (grant) => grant.protocol !== "any" || grant.ports === "all",
    "指定端口时必须选择 TCP 或 UDP",
  );
export const fileResourceSchema = z
  .object({
    name,
    source: absolutePath,
    target: absolutePath,
    mode: z.enum(["copy", "direct"]).default("copy"),
    access: z.enum(["read-only", "read-write"]).default("read-only"),
  })
  .strict();
// 清单记录验证过的调用组合，不自动改变全局代理或关闭证书验证。
export const auditedClientSchema = z
  .object({
    id: name,
    tool: z.enum(["curl", "wget", "python"]),
    version: z.string().min(1),
    library: z.string().min(1).optional(),
    trustStore: z.enum(["system", "explicit-ca-file", "client-bundle"]),
    invocation: z.array(z.string().min(1)).min(1),
  })
  .strict();
// 此 Schema 只用于宿主状态目录，项目配置不能直接携带授权。
export const hostPermissionsSchema = z
  .object({
    version: z.literal(1).default(1),
    // 缺省字段不补写，保持旧冻结快照的摘要；新任务默认值由加载入口设置，旧快照由访问模块解释。
    project: z
      .object({ mode: z.enum(["isolated", "direct"]) })
      .strict()
      .optional(),
    network: z
      .object({ grants: z.array(networkGrantSchema).default([]) })
      .strict()
      .default({ grants: [] }),
    resources: z
      .array(fileResourceSchema)
      .refine(
        (values) =>
          new Set(values.map((value) => value.name)).size === values.length,
        "资源名称不可重复",
      )
      .default([]),
    decoys: z
      .object({
        enabled: z.boolean().default(false),
        clients: z
          .array(auditedClientSchema)
          .refine(
            (values) =>
              new Set(values.map((value) => value.id)).size === values.length,
            "客户端编号不可重复",
          )
          .default([]),
      })
      .strict()
      .default({ enabled: false, clients: [] }),
  })
  .strict();
