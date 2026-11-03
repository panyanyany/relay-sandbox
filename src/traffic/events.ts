import { z } from "zod";

// 只保存客户端声明的最小进程身份，不能当作宿主内核验证的归因证据。
export const invocationSchema = z
  .object({
    requestId: z.uuidv4(),
    invocationId: z.uuidv4(),
    tool: z.enum(["curl", "wget", "python"]),
    pid: z.number().int().min(1).max(2147483647),
    parentPid: z.number().int().min(0).max(2147483647),
    processStartTicks: z.string().regex(/^[0-9]{1,20}$/),
    startedAt: z.iso.datetime(),
    executable: z.enum(["/usr/bin/curl", "/usr/bin/wget", "/usr/bin/python3"]),
    source: z.literal("client-reported"),
    pidNamespace: z.literal("container"),
  })
  .strict()
  .refine(
    (context) =>
      context.executable ===
      {
        curl: "/usr/bin/curl",
        wget: "/usr/bin/wget",
        python: "/usr/bin/python3",
      }[context.tool],
    "工具与声明的可执行程序不一致",
  );

// 写盘前严格筛选字段：目标只有主机，不允许完整URL、请求片段或凭据。
export const trafficEventSchema = z
  .object({
    time: z.iso.datetime({ offset: true }),
    host: z.string().regex(/^[A-Za-z0-9._:\[\]-]{1,253}$/),
    port: z.number().int().min(1).max(65535),
    decoyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    encoding: z.enum(["raw", "url-percent", "base64", "base64url"]),
    location: z.enum(["target", "header", "body"]),
    invocation: invocationSchema.optional(),
    // 汇总读取时由宿主目录补充，避免将不同容器的PID混为同一进程。
    runtimeId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
      .optional(),
  })
  .strict();

// 缺口说明观察范围；无命中不能解释为无外传或远端未收到。
export const trafficGapSchema = z
  .object({
    reason: z.enum([
      "size-limit",
      "unsupported-content-encoding",
      "invocation-context-invalid",
    ]),
    location: z.enum(["target", "header", "body"]),
  })
  .strict();
export const trafficMatchResultSchema = z
  .object({
    events: z.array(trafficEventSchema).max(512),
    gaps: z.array(trafficGapSchema).max(2),
  })
  .strict();
export type TrafficEvent = z.infer<typeof trafficEventSchema>;
export type TrafficGap = z.infer<typeof trafficGapSchema>;
export type TrafficMatchResult = z.infer<typeof trafficMatchResultSchema>;
