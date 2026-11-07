import type Docker from "dockerode";
import { startInteractiveExec } from "../../docker/interactive.js";
import type { NativeSessionLaunchContext } from "./contract.js";
import { createCodexSkills } from "./codex-skills.js";
import { codexSessionAdapter } from "./codex.js";
import { createCodexGateway, type CodexGatewayInput } from "./codex-gateway.js";

// app-server 始终只在容器执行，统一输入不提供原生 renderer。
export async function createCodexDriver(
  input: Omit<CodexGatewayInput, "upstream"> & {
    docker: Docker;
    containerId: string;
    context: NativeSessionLaunchContext;
  },
) {
  const launch = codexSessionAdapter.launch(input.context);
  const upstream = await startInteractiveExec(input.docker, {
    containerId: input.containerId,
    argv: [launch.command, ...launch.args],
    env: { ...launch.environment },
    tty: false,
  });
  try {
    const gateway = await createCodexGateway({ ...input, upstream });
    const skills = createCodexSkills(gateway);
    // 只暴露结构化请求与原生技能能力，不提供绕过 worker 的输入入口。
    return {
      nativeSessionId: gateway.nativeSessionId,
      read: gateway.read,
      submitInputs: gateway.submitInputs,
      submit: gateway.submit,
      stop: gateway.stop,
      close: gateway.close,
      capabilities: skills.capabilities,
      listSkills: skills.listSkills,
      execute: skills.execute,
    };
  } catch (error) {
    upstream.stdin.end();
    throw error;
  }
}
