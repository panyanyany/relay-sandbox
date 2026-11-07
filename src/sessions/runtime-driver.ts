import type Docker from "dockerode";
import { withFinalizer } from "../storage/finalize.js";
import { createCodexDriver } from "../agents/sessions/codex-driver.js";
import { createStructuredClaudeDriver } from "../agents/sessions/claude-driver.js";
import { createOpenCodeDriver } from "../agents/sessions/opencode-driver.js";
import type { ensureSessionEnvironment } from "./environment.js";
import type { WorkerSessionDriver, NativeWorkerControls } from "./worker.js";
// 只识别既有开发适配器的密钥位置，宿主审查档案从不进入这里。
export function developmentSecrets(env: Readonly<Record<string, string>>) {
  const key =
    env.RELAY_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    (env.OPENCODE_CONFIG_CONTENT
      ? (
          JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
            provider?: { relay?: { options?: { apiKey?: string } } };
          }
        ).provider?.relay?.options?.apiKey
      : undefined);
  if (!key) throw new Error("开发环境未包含专用中转凭据");
  return [key];
}
// 厂商协议各自拥有原生上下文；这里仅装配传输与最小开发配置。
export async function createRuntimeDriver(input: {
  home: string;
  prepared: Awaited<ReturnType<typeof ensureSessionEnvironment>>;
  docker: Docker;
  controls: NativeWorkerControls;
  bindNative(id: string): Promise<void>;
  secrets: string[];
}): Promise<WorkerSessionDriver> {
  const { session, task, profile, env } = input.prepared;
  if (!task.containerId) throw new Error("结构化会话没有运行容器");
  const shared = {
    docker: input.docker,
    containerId: task.containerId,
    environment: env,
    controls: input.controls,
    emit: input.controls.emit,
    bindNative: input.bindNative,
    ...(session.nativeSessionId ? { nativeId: session.nativeSessionId } : {}),
  };
  if (session.agent === "codex") {
    const driver = await createCodexDriver({
      docker: input.docker,
      containerId: task.containerId,
      context: {
        session,
        workspace: "/workspace",
        endpoint: profile.endpoint,
        model: profile.model,
        environment: env,
      },
      ...(session.nativeSessionId
        ? { nativeSessionId: session.nativeSessionId }
        : {}),
      bindNativeSession: input.bindNative,
      emit: input.controls.emit,
      fail: input.controls.fail,
    });
    // 只装配 worker 使用的结构化能力，原生厂商身份仍由绑定回调保存。
    return {
      submit: driver.submit,
      execute: driver.execute,
      capabilities: driver.capabilities,
      listSkills: driver.listSkills,
      stop: driver.stop,
      close: driver.close,
    };
  }
  if (session.agent === "opencode") {
    const driver = await createOpenCodeDriver({
      ...shared,
    });
    return {
      submit: (prompt) => driver.submit(prompt),
      execute: (request) => driver.execute(request),
      capabilities: () => driver.capabilities(),
      listSkills: () => driver.listSkills(),
      stop: () => driver.stop(),
      close: () => driver.close(),
    };
  }
  const driver = createStructuredClaudeDriver({
    ...shared,
    model: profile.model,
  });
  try {
    // 无 prompt 的真实就绪检查结束后，worker 才能发布控制 socket。
    await driver.ready();
    return {
      submit: (prompt, context) => driver.submit(prompt, context),
      execute: (request, context) => driver.execute(request, context),
      capabilities: () => driver.capabilities(),
      listSkills: () => driver.listSkills(),
      stop: () => driver.stop(),
      close: () => driver.close(),
    };
  } catch (error) {
    return withFinalizer(
      async () => {
        throw error;
      },
      () => driver.close(),
    );
  }
}
