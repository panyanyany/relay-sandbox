import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  trafficEventSchema,
  trafficGapSchema,
  type TrafficEvent,
} from "../traffic/events.js";
import { taskPath } from "../tasks/store.js";

// 固定目录句柄逐层打开，读取前限制大小，拒绝链接和采样期间的替换。
export async function readBoundedEvidence(
  root: string,
  path: string,
  limit = 1024 * 1024,
  accountRead?: (bytes: number) => void,
): Promise<Buffer> {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("证据路径非法");
  let directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
    }
    const file = await open(
      `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new Error("证据不是普通文件");
      if (before.size > BigInt(limit))
        throw Object.assign(new Error("证据超过大小限制"), { code: "EFBIG" });
      // 汇总路径按实际读取扣预算，读取后校验失败也不能退回预算。
      // 有预算时不多读保护字节；读后stat仍会拒绝文件增长或替换。
      const buffer = Buffer.alloc(limit + (accountRead ? 0 : 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        accountRead?.(bytesRead);
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (length > limit)
        throw Object.assign(new Error("证据超过大小限制"), { code: "EFBIG" });
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error("证据读取期间变化");
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } finally {
    await directory.close();
  }
}

export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_MAX_RECORDS = 20000;

// 当前主环境优先进入有界摘要；坏指针只形成缺口，不扩大文件读取范围。
export async function orderEnvironmentIds(
  root: string,
  ids: string[],
  gaps: Set<string>,
) {
  try {
    const pointer = JSON.parse(
      (
        await readBoundedEvidence(root, "traffic/latest-main.json", 4096)
      ).toString("utf8"),
    ) as { runtimeId?: unknown };
    if (
      typeof pointer.runtimeId !== "string" ||
      !ids.includes(pointer.runtimeId)
    )
      throw new Error("主环境指针无效");
    return [pointer.runtimeId, ...ids.filter((id) => id !== pointer.runtimeId)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      gaps.add("main-environment-unavailable");
    return ids;
  }
}

// 单次汇总最多4MiB、20000条记录；当前主环境及当前段优先，计数仅含已扫描证据。
export async function readTrafficEvidence(home: string, id: string) {
  const root = taskPath(home, id),
    gaps = new Set<string>();
  const events: TrafficEvent[] = [];
  let eventCount = 0,
    observed = false,
    truncated = false,
    bytes = 0,
    records = 0;
  let directory;
  try {
    directory = await open(
      `${root}/traffic`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      events,
      eventCount,
      gaps: [missing ? "missing-evidence" : "unreadable-evidence"],
      truncated,
      coverage: "unavailable" as const,
    };
  }
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = (
      await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 128) {
      gaps.add("environment-limit");
      truncated = true;
    }
    const ids = await orderEnvironmentIds(
      root,
      entries.map((entry) => entry.name),
      gaps,
    );
    scan: for (const name of ids.slice(0, 128)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
        gaps.add("invalid-environment-id");
        continue;
      }
      for (const kind of ["events", "gaps"] as const)
        for (const suffix of ["", ".1", ".2"]) {
          const remaining = EVIDENCE_MAX_BYTES - bytes;
          if (remaining <= 0) {
            gaps.add("evidence-byte-budget");
            truncated = true;
            break scan;
          }
          let data: Buffer;
          try {
            data = await readBoundedEvidence(
              `/proc/self/fd/${directory.fd}/.`,
              `${name}/evidence/${kind}.jsonl${suffix}`,
              Math.min(1024 * 1024, remaining),
              (count) => {
                bytes += count;
              },
            );
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EFBIG" && remaining < 1024 * 1024) {
              gaps.add("evidence-byte-budget");
              truncated = true;
              break scan;
            }
            if (code !== "ENOENT")
              gaps.add(
                code === "EFBIG" ? "oversized-evidence" : "unreadable-evidence",
              );
            continue;
          }
          observed = true;
          if (suffix) gaps.add("rotated-evidence");
          for (const line of data
            .toString("utf8")
            .split("\n")
            .filter(Boolean)) {
            if (records >= EVIDENCE_MAX_RECORDS) {
              gaps.add("evidence-record-budget");
              truncated = true;
              break scan;
            }
            records++;
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              gaps.add("invalid-evidence");
              continue;
            }
            if (kind === "events") {
              const parsed = trafficEventSchema.safeParse(value);
              if (!parsed.success) {
                gaps.add("invalid-evidence");
                continue;
              }
              eventCount++;
              if (events.length < 100)
                events.push({ ...parsed.data, runtimeId: name });
              else {
                truncated = true;
                gaps.add("event-limit");
              }
            } else {
              const parsed = trafficGapSchema.safeParse(value);
              if (parsed.success) gaps.add(parsed.data.reason);
              else gaps.add("invalid-evidence");
            }
          }
        }
    }
  } finally {
    await directory.close();
  }
  if (!observed) gaps.add("missing-evidence");
  gaps.add("selected-client-coverage");
  return {
    events,
    eventCount,
    gaps: [...gaps].sort(),
    truncated,
    coverage: observed ? ("partial" as const) : ("unavailable" as const),
  };
}
