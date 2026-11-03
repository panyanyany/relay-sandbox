import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  invocationSchema,
  trafficEventSchema,
} from "../../src/traffic/events.js";

// 直接执行共享Python契约，不在测试中复制客户端的进程采集算法。
function contextScript(script: string, input: unknown = null) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import sys,json,uuid;sys.path.insert(0,'scripts');import traffic_context as c\n${script}`,
      ],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
      },
    ),
  );
}
test("进程声明采集真实PID和启动标识，代理请求编号独立于调用编号", () => {
  const value = contextScript(
    "value=c.decode_context(c.encode_context('curl'));value['requestId']=str(uuid.uuid4());print(json.dumps(value))",
  );
  expect(invocationSchema.parse(value)).toMatchObject({
    tool: "curl",
    executable: "/usr/bin/curl",
    source: "client-reported",
    pidNamespace: "container",
  });
  expect(value.pid).toBeGreaterThan(0);
  expect(value.parentPid).toBeGreaterThan(0);
  expect(value.processStartTicks).toMatch(/^[0-9]+$/);
  expect(value.requestId).not.toBe(value.invocationId);
  expect(value).not.toHaveProperty("argv");
  expect(value).not.toHaveProperty("environment");
});
test("坏上下文和附带内容不能进入最小证据，旧事件仍可读取", () => {
  const result = contextScript(`import base64
value=c.decode_context(c.encode_context('python'))
value.pop('source');value.pop('pidNamespace')
variants=[dict(value,pid=True),dict(value,pid=-1),dict(value,tool=[]),dict(value,argv='private'),dict(value,executable='/private/secret'),dict(value,startedAt='bad'),dict(value,invocationId='bad')]
rejected=[]
for item in variants:
 try:
  c.decode_context(base64.urlsafe_b64encode(json.dumps(item).encode()).decode());rejected.append(False)
 except (ValueError,TypeError): rejected.append(True)
for token in ['!', 'a'*2049,base64.urlsafe_b64encode(b'private-not-json').decode()]:
 try: c.decode_context(token);rejected.append(False)
 except (ValueError,TypeError): rejected.append(True)
print(json.dumps(rejected))`);
  expect(result.every(Boolean)).toBe(true);
  const event = {
    time: "2026-11-02T12:00:00Z",
    host: "example.test",
    port: 443,
    decoyId: "aws",
    encoding: "raw",
    location: "body",
  };
  expect(trafficEventSchema.parse(event)).toEqual(event);
  expect(
    trafficEventSchema.safeParse({
      ...event,
      invocation: { pid: 1, argv: "private" },
    }).success,
  ).toBe(false);
});

// 宿主拒绝结构损坏的声明；来源标签不得升级为内核核验。
test("宿主严格校验关联字段和来源，不接受伪造的核验标签", () => {
  const context = contextScript(
    "value=c.decode_context(c.encode_context('wget'));value['requestId']=str(uuid.uuid4());print(json.dumps(value))",
  );
  for (const patch of [
    { pid: true },
    { parentPid: -1 },
    { processStartTicks: "unknown" },
    { executable: "/bin/sh" },
    { source: "kernel-verified" },
    { requestId: "bad" },
    { argv: "private" },
  ]) {
    expect(invocationSchema.safeParse({ ...context, ...patch }).success).toBe(
      false,
    );
  }
});
