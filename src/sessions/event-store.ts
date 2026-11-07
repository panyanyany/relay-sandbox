import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  sessionEventInputSchema,
  sessionEventSchema,
  type SessionEvent,
  type SessionEventInput,
  type SessionEventReplay,
} from "./events.js";

interface Limits {
  maxEvents?: number;
  maxBytes?: number;
}
const headerSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const queues = new Map<string, Promise<unknown>>();
function paths(home: string, id: string) {
  z.uuid().parse(id);
  const directory = join(home, "sessions", id);
  return {
    directory,
    file: join(directory, "events.jsonl"),
    lock: join(directory, "event.lock"),
  };
}
async function readStore(file: string, id: string) {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { cursor: 0, events: [] as SessionEvent[] };
    throw error;
  }
  const lines = content.trimEnd().split("\n");
  const header = headerSchema.parse(JSON.parse(lines.shift()!));
  const events = lines.map((line) =>
    sessionEventSchema.parse(JSON.parse(line)),
  );
  let previous = events[0] ? events[0].cursor - 1 : header.cursor;
  for (const event of events) {
    if (event.sessionId !== id || event.cursor !== previous + 1)
      throw new Error("会话事件身份或游标不连续");
    previous = event.cursor;
  }
  if (previous !== header.cursor) throw new Error("会话事件头游标与内容不一致");
  return { cursor: header.cursor, events };
}
// 同进程排队；跨进程竞争明确失败，由唯一后台写入者协调，不能吞掉事件。
export async function appendSessionEvent(
  home: string,
  id: string,
  input: SessionEventInput,
  limits: Limits = {},
): Promise<SessionEvent> {
  const location = paths(home, id);
  const parsed = sessionEventInputSchema.parse(input);
  const maxEvents = z
    .number()
    .int()
    .positive()
    .parse(limits.maxEvents ?? 1_000);
  const maxBytes = z
    .number()
    .int()
    .positive()
    .parse(limits.maxBytes ?? 4_194_304);
  const prior = queues.get(location.file) ?? Promise.resolve();
  const operation = prior
    .catch(() => undefined)
    .then(async () => {
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      const lock = await open(location.lock, "wx", 0o600);
      try {
        const store = await readStore(location.file, id);
        const event = sessionEventSchema.parse({
          ...parsed,
          version: 1,
          sessionId: id,
          cursor: store.cursor + 1,
          timestamp: new Date().toISOString(),
        });
        const header =
          JSON.stringify({ version: 1, cursor: event.cursor }) + "\n";
        const line = JSON.stringify(event) + "\n";
        if (
          Buffer.byteLength(line) > 262_144 ||
          Buffer.byteLength(header + line) > maxBytes
        )
          throw new Error("会话事件超过容量预算");
        const retained = [...store.events, event]
          .slice(-maxEvents)
          .map((entry) => JSON.stringify(entry) + "\n");
        let bytes = Buffer.byteLength(header + retained.join(""));
        while (bytes > maxBytes && retained.length > 1)
          bytes -= Buffer.byteLength(retained.shift()!);
        const temp = `${location.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, header + retained.join(""), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temp, location.file);
        } finally {
          await unlink(temp).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        return event;
      } finally {
        await lock.close();
        await unlink(location.lock);
      }
    });
  queues.set(location.file, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(location.file) === operation) queues.delete(location.file);
  }
}
// 游标超过已知历史通常表示客户端串用了会话，不将其当作空结果兜底。
export async function replaySessionEvents(
  home: string,
  id: string,
  after = 0,
): Promise<SessionEventReplay> {
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
  const store = await readStore(paths(home, id).file, id);
  if (after > store.cursor) throw new Error("请求游标超过会话历史");
  const first = store.events[0]?.cursor ?? store.cursor + 1;
  return {
    cursor: store.cursor,
    events: store.events.filter((event) => event.cursor > after),
    ...(after < first - 1
      ? {
          gap: { from: after + 1, to: first - 1, reason: "retention" as const },
        }
      : {}),
  };
}
