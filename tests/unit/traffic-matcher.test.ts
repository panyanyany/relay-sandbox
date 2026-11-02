import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { trafficMatchResultSchema } from "../../src/traffic/events.js";

// 测试通过独立Python进程调用公开函数，不复制生产匹配算法。
function match(content: string, extra: Record<string, unknown> = {}) {
  const script = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('traffic_match','scripts/traffic-match.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\na=json.load(sys.stdin);print(json.dumps(m.match_content(**a)))`;
  const result = execFileSync("python3", ["-c", script], {
    input: JSON.stringify({
      content,
      entries: [{ id: "fake-01", value: "secret?" }],
      host: "example.test",
      port: 443,
      location: "body",
      time: "2026-11-02T12:00:00Z",
      ...extra,
    }),
    encoding: "utf8",
  });
  return trafficMatchResultSchema.parse(JSON.parse(result));
}

describe("最小诱饵通信证据", () => {
  it("识别原值和混合percent编码，不持久化内容片段", () => {
    const result = match("PRIVATE_BODY_MARKER secret? %73ecret%3F");
    expect(result.events.map((event) => event.encoding)).toEqual([
      "raw",
      "url-percent",
    ]);
    expect(result.events[0]).toEqual({
      time: "2026-11-02T12:00:00Z",
      host: "example.test",
      port: 443,
      decoyId: "fake-01",
      encoding: "raw",
      location: "body",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_MARKER");
    expect(JSON.stringify(result)).not.toContain("secret?");
    expect(
      match("secret? unrelated%20text").events.map((event) => event.encoding),
    ).toEqual(["raw"]);
  });
  it("识别标准和URLsafe Base64有无padding的一层表示", () => {
    expect(
      match("c2VjcmV0Pw==").events.some((event) => event.encoding === "base64"),
    ).toBe(true);
    expect(
      match("c2VjcmV0Pw").events.some(
        (event) => event.encoding === "base64url",
      ),
    ).toBe(true);
    // 该值的标准和URLsafe编码不同，预期来自固定worked例子。
    const entries = [{ id: "binary-01", value: "~~~???" }];
    expect(
      match("fn5+Pz8/", { entries }).events.some(
        (event) => event.encoding === "base64",
      ),
    ).toBe(true);
    expect(
      match("fn5-Pz8_", { entries }).events.some(
        (event) => event.encoding === "base64url",
      ),
    ).toBe(true);
  });
  it("超限内容显式记缺口，不检查截限后的部分；无诱饵不伪造命中", () => {
    const result = match("12345678secret?", { max_bytes: 8 });
    expect(result.events).toEqual([]);
    expect(result.gaps).toContainEqual({
      reason: "size-limit",
      location: "body",
    });
    expect(match("secret?", { entries: [] }).events).toEqual([]);
    expect(
      match("secret?", { content_encoding: "unknown-compression" }).gaps,
    ).toContainEqual({
      reason: "unsupported-content-encoding",
      location: "body",
    });
  });
  it("严格事件拒绝片段、完整URL及非法字段", () => {
    const result = match("secret?");
    expect(() =>
      trafficMatchResultSchema.parse({
        ...result,
        events: [{ ...result.events[0], body: "leak" }],
      }),
    ).toThrow();
    expect(() =>
      trafficMatchResultSchema.parse({
        ...result,
        events: [
          {
            ...result.events[0],
            host: "https://example.test/path?token=value",
          },
        ],
      }),
    ).toThrow();
  });
});
