import { describe, expect, it, vi } from "vitest";
import { createOpenCodeSkills } from "../../src/agents/sessions/opencode-skills.js";

// 对照实际 /skill 响应，只暴露技能标识与说明，不传播内容或本机路径。
function fixture(body: unknown = []) {
  const readCapability = vi.fn().mockResolvedValue({ status: 200, body });
  const submit = vi.fn().mockResolvedValue(undefined);
  return {
    readCapability,
    submit,
    skills: createOpenCodeSkills({ readCapability, submit }),
  };
}

describe("OpenCode 原生技能", () => {
  it("映射真实列表，命令列表不冒充技能", async () => {
    const input = fixture([
      {
        name: "review",
        description: "代码审查",
        location: "/private/skills",
        content: "私有内容",
      },
    ]);
    await expect(input.skills.listSkills()).resolves.toEqual([
      { name: "review", description: "代码审查" },
    ]);
    expect(input.readCapability).toHaveBeenCalledExactlyOnceWith("/skill");
    expect((await input.skills.capabilities()).skills.list.status).toBe(
      "supported",
    );
    expect((await input.skills.capabilities()).skills.invoke.status).toBe(
      "unsupported",
    );
    expect(input.submit).not.toHaveBeenCalled();
  });

  it("未知及已知技能均不转为提示词执行", async () => {
    const input = fixture([{ name: "review", description: "审查" }]);
    for (const name of ["review", "unknown"]) {
      await expect(
        input.skills.execute({ type: "skill", name, args: "some code" }),
      ).rejects.toThrow("不支持独立原生技能调用");
    }
    expect(input.submit).not.toHaveBeenCalled();
    expect(input.readCapability).not.toHaveBeenCalled();
  });

  it("普通消息保留原文", async () => {
    const input = fixture();
    await input.skills.execute({ type: "message", prompt: "  保留\n原文  " });
    expect(input.submit).toHaveBeenCalledExactlyOnceWith("  保留\n原文  ");
  });

  it("上游 HTTP 与传输故障直接抛出", async () => {
    const input = fixture();
    input.readCapability.mockResolvedValueOnce({ status: 503, body: {} });
    await expect(input.skills.listSkills()).rejects.toThrow("HTTP 503");
    const failure = new Error("连接断开");
    input.readCapability.mockRejectedValueOnce(failure);
    await expect(input.skills.listSkills()).rejects.toBe(failure);
  });

  it.each([{}, [{ name: "../escape" }], [{ name: "valid", description: 3 }]])(
    "拒绝不合法响应 %j",
    async (body) => {
      await expect(fixture(body).skills.listSkills()).rejects.toThrow();
    },
  );
});
