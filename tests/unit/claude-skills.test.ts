import { describe, expect, it, vi } from "vitest";
import Docker from "dockerode";
import { startInteractiveExec } from "../../src/docker/interactive.js";
import { createStructuredClaudeDriver } from "../../src/agents/sessions/claude-driver.js";
import { createClaudeSkills } from "../../src/agents/sessions/claude-skills.js";

vi.mock("../../src/docker/interactive.js", () => ({ startInteractiveExec: vi.fn() }));

describe("Claude 原生技能投影", () => {
  it("尚未收到初始化时明确不可发现，且不发探测请求", () => {
    const getInitialization = vi.fn(() => undefined);
    const skills = createClaudeSkills({ getInitialization });
    expect(skills.capabilities().skills.list.status).toBe("unsupported");
    expect(() => skills.list()).toThrow("尚未收到");
    expect(getInitialization).toHaveBeenCalledTimes(2);
  });

  it("只读取已缓存的 skills，不把普通 slash_commands 当技能", () => {
    const skills = createClaudeSkills({
      getInitialization: () => ({
        skills: ["audit", "team/check"],
        slash_commands: ["compact", "help"],
      }),
    });
    expect(skills.list()).toEqual([{ name: "audit" }, { name: "team/check" }]);
    expect(skills.capabilities().skills).toMatchObject({
      list: { status: "supported" },
      invoke: { status: "unsupported" },
    });
  });

  it("缺少技能字段不能声称空列表，协议异常保留错误", () => {
    const missing = createClaudeSkills({ getInitialization: () => ({}) });
    expect(missing.capabilities().skills.list.status).toBe("unsupported");
    expect(() => missing.list()).toThrow("没有提供");
    const malformed = createClaudeSkills({
      getInitialization: () => ({ skills: ["../bad"] }),
    });
    expect(() => malformed.list()).toThrow();
  });

  it("未知技能不启动进程，消息仍通过已有 submit", async () => {
    const driver = createStructuredClaudeDriver({
      docker: new Docker(), containerId: "synthetic", model: "fake",
      environment: {}, bindNative: vi.fn(async () => {}),
    });
    const context = {
      emit: vi.fn(async () => {}),
      lease: { token: "synthetic", kind: "development" as const, pid: 1, identity: "test", createdAt: new Date().toISOString() },
    };
    await expect(driver.execute({ type: "skill", name: "unknown" }, context)).rejects.toThrow("未验证");
    expect(startInteractiveExec).not.toHaveBeenCalled();
    const submit = vi.spyOn(driver, "submit").mockResolvedValue();
    await driver.execute({ type: "message", prompt: "原样消息" }, context);
    expect(submit).toHaveBeenCalledExactlyOnceWith("原样消息", context);
    expect((await driver.capabilities()).skills.list.status).toBe("unsupported");
  });
});
