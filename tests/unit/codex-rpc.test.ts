import { describe, expect, it } from "vitest";
import {
  createCodexRpc,
  type CodexRpcMessage,
} from "../../src/agents/sessions/codex-rpc.js";

// 从传输边界观察请求与响应，不依赖网关内部状态。
function fixture() {
  const sent: CodexRpcMessage[] = [];
  const rpc = createCodexRpc((message) => {
    sent.push(message);
  });
  return { rpc, sent };
}

describe("Codex RPC 请求关联", () => {
  it("按请求 ID 关联乱序响应，未知响应不影响待处理请求", async () => {
    const { rpc, sent } = fixture();
    const first = rpc.request("initialize", { clientInfo: {} });
    const second = rpc.request("thread/read");
    expect(sent.map((message) => message.id)).toEqual([1, 2]);
    expect(rpc.accept({ id: 999, result: "ignored" })).toBe(true);
    rpc.accept({ id: 2, result: "second" });
    rpc.accept({ id: 1, result: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(rpc.accept({ method: "turn/started" })).toBe(false);
  });

  it("传播初始化协议错误，并允许后续独立请求", async () => {
    const { rpc } = fixture();
    const initialize = rpc.request("initialize");
    const rejected = expect(initialize).rejects.toThrow("初始化被拒绝");
    rpc.accept({ id: 1, error: { code: -32000, message: "初始化被拒绝" } });
    await rejected;
    const next = rpc.request("account/read");
    rpc.accept({ id: 2, result: null });
    await expect(next).resolves.toBeNull();
  });

  it("断开拒绝所有挂起请求以及后续请求，保留原始错误", async () => {
    const { rpc, sent } = fixture();
    const error = new Error("上游断开");
    const first = expect(rpc.request("initialize")).rejects.toBe(error);
    const second = expect(rpc.request("thread/read")).rejects.toBe(error);
    rpc.close(error);
    rpc.close(new Error("重复关闭"));
    await Promise.all([first, second]);
    await expect(rpc.request("thread/list")).rejects.toBe(error);
    expect(sent).toHaveLength(2);
  });

  it("同步写入失败不会遗留挂起请求", async () => {
    const error = new Error("管道写入失败");
    const rpc = createCodexRpc(() => {
      throw error;
    });
    await expect(rpc.request("initialize")).rejects.toBe(error);
    rpc.close(new Error("关闭"));
  });
});
