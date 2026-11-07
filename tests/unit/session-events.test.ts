import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  appendSessionEvent,
  replaySessionEvents,
} from "../../src/sessions/event-store.js";

import { sessionEventSchema } from "../../src/sessions/events.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "session-events-"));
  homes.push(home);
  return { home, id: randomUUID() };
}
const message = {
  type: "message" as const,
  payload: { role: "assistant" as const, text: "你好", complete: true },
};

it("追加、重新读取与 after 游标不会重复", async () => {
  const { home, id } = await fixture();
  const first = await appendSessionEvent(home, id, message);
  expect(first.cursor).toBe(1);
  expect(sessionEventSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(
    first,
  );
  expect((await appendSessionEvent(home, id, message)).cursor).toBe(2);
  expect(
    (await replaySessionEvents(home, id, 1)).events.map((e) => e.cursor),
  ).toEqual([2]);
  expect((await replaySessionEvents(home, id, 2)).events).toEqual([]);
});
it("轮转明确返回缺口，序号不会重用", async () => {
  const { home, id } = await fixture();
  for (let i = 0; i < 4; i++)
    await appendSessionEvent(home, id, message, { maxEvents: 2 });
  const replay = await replaySessionEvents(home, id, 0);
  expect(replay.gap).toEqual({ from: 1, to: 2, reason: "retention" });
  expect(replay.events.map((e) => e.cursor)).toEqual([3, 4]);
  expect(
    (await appendSessionEvent(home, id, message, { maxEvents: 2 })).cursor,
  ).toBe(5);
});
it("并发写入不覆盖", async () => {
  const { home, id } = await fixture();
  await Promise.all(
    Array.from({ length: 8 }, () => appendSessionEvent(home, id, message)),
  );
  expect(
    (await replaySessionEvents(home, id)).events.map((e) => e.cursor),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});
it("非法身份、游标、事件及大小显式拒绝", async () => {
  const { home, id } = await fixture();
  await expect(
    appendSessionEvent(home, "../escape", message),
  ).rejects.toThrow();
  await expect(replaySessionEvents(home, id, -1)).rejects.toThrow();
  await appendSessionEvent(home, id, message);
  await expect(replaySessionEvents(home, id, 2)).rejects.toThrow("游标");
  await expect(
    appendSessionEvent(home, id, {
      ...message,
      payload: { ...message.payload, text: "x".repeat(65_537) },
    }),
  ).rejects.toThrow();
  await expect(
    appendSessionEvent(home, id, message, { maxBytes: 20 }),
  ).rejects.toThrow();
});

// 错误示范：跨进程抢写后静默返回，会让调用方误以为日志已保存。
it("其他进程持有事件锁时明确失败，历史不变", async () => {
  const { home, id } = await fixture();
  await appendSessionEvent(home, id, message);
  await writeFile(join(home, "sessions", id, "event.lock"), "owned");
  await expect(appendSessionEvent(home, id, message)).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect((await replaySessionEvents(home, id)).cursor).toBe(1);
});
it("字节轮转有缺口，损坏日志不伪装成空历史", async () => {
  const { home, id } = await fixture();
  for (let i = 0; i < 3; i++)
    await appendSessionEvent(home, id, message, { maxBytes: 300 });
  expect((await replaySessionEvents(home, id)).gap).toBeDefined();
  await writeFile(join(home, "sessions", id, "events.jsonl"), "not json\n");
  await expect(replaySessionEvents(home, id)).rejects.toThrow();
  await expect(appendSessionEvent(home, id, message)).rejects.toThrow();
});
