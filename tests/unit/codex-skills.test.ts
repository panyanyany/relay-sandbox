import { describe, expect, it, vi } from "vitest";
import { createCodexSkills } from "../../src/agents/sessions/codex-skills.js";
import type { SessionOperationLease } from "../../src/sessions/operation.js";

// 真实RPC列表包含每个工作目录的skills，执行路径只能来自该列表。
function fixture() {
  const read = vi.fn().mockResolvedValue({
    data: [
      {
        skills: [
          {
            name: "audit",
            path: "/skills/audit/SKILL.md",
            description: "审查",
          },
        ],
      },
    ],
  });
  const submitInputs = vi.fn().mockResolvedValue(undefined);
  const submit = vi.fn().mockResolvedValue(undefined);
  return { read, submitInputs, submit };
}
const lease = { token: "saved-request" } as SessionOperationLease;

describe("Codex原生技能", () => {
  it("只读发现投影原生列表而不执行", async () => {
    const backend = fixture();
    const skills = createCodexSkills(backend);
    expect((await skills.capabilities()).skills.invoke.status).toBe(
      "supported",
    );
    expect(await skills.listSkills()).toEqual([
      { name: "audit", description: "审查" },
    ]);
    expect(backend.read).toHaveBeenCalledWith("skills/list", {
      cwds: ["/workspace"],
    });
    expect(backend.submitInputs).not.toHaveBeenCalled();
  });
  it("使用原生skill输入和独立参数文本", async () => {
    const backend = fixture();
    await createCodexSkills(backend).execute(
      { type: "skill", name: "audit", args: "检查改动" },
      { lease },
    );
    expect(backend.submitInputs).toHaveBeenCalledWith(
      [
        { type: "skill", name: "audit", path: "/skills/audit/SKILL.md" },
        { type: "text", text: "检查改动" },
      ],
      { lease },
    );
  });
  it("消息继续使用原submit", async () => {
    const backend = fixture();
    await createCodexSkills(backend).execute(
      { type: "message", prompt: "你好" },
      { lease },
    );
    expect(backend.submit).toHaveBeenCalledWith("你好", { lease });
    expect(backend.read).not.toHaveBeenCalled();
  });
  it("未知技能和空列表不执行", async () => {
    const backend = fixture();
    await expect(
      createCodexSkills(backend).execute(
        { type: "skill", name: "missing" },
        { lease },
      ),
    ).rejects.toThrow("未找到");
    backend.read.mockResolvedValue({ data: [{ skills: [] }] });
    await expect(
      createCodexSkills(backend).execute(
        { type: "skill", name: "audit" },
        { lease },
      ),
    ).rejects.toThrow("未找到");
    expect(backend.submitInputs).not.toHaveBeenCalled();
  });
  it("上游错误和无效协议不会被伪装为空列表", async () => {
    const backend = fixture();
    const error = new Error("原生列表失败");
    backend.read.mockRejectedValueOnce(error);
    await expect(createCodexSkills(backend).listSkills()).rejects.toBe(error);
    backend.read.mockResolvedValue({ data: [{}] });
    await expect(createCodexSkills(backend).listSkills()).rejects.toThrow();
    expect(backend.submitInputs).not.toHaveBeenCalled();
  });
  it("同名不同路径拒绝歧义，执行错误原样保留", async () => {
    const backend = fixture();
    backend.read.mockResolvedValueOnce({
      data: [
        {
          skills: [
            { name: "audit", path: "/a" },
            { name: "audit", path: "/b" },
          ],
        },
      ],
    });
    await expect(
      createCodexSkills(backend).execute(
        { type: "skill", name: "audit" },
        { lease },
      ),
    ).rejects.toThrow("歧义");
    const error = new Error("执行失败");
    backend.submitInputs.mockRejectedValue(error);
    await expect(
      createCodexSkills(backend).execute(
        { type: "skill", name: "audit" },
        { lease },
      ),
    ).rejects.toBe(error);
  });
});
