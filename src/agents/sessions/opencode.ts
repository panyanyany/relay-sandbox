import type { NativeSessionAdapter } from "./contract.js";
export { createOpenCodeDriver } from "./opencode-driver.js";
// OpenCode 原生 UI 与结构化消息使用同一 serve；stdout 不承担消息协议。
export const openCodeSessionAdapter: NativeSessionAdapter = {
  agent: "opencode",
  launch(context) {
    return {
      command: "opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4997"],
      environment: context.environment,
    };
  },
  nativeSessionId(message) {
    const params = message.params as { info?: { id?: string } } | undefined;
    return message.method === "session.created" ? params?.info?.id : undefined;
  },
  events() {
    return [];
  },
};
