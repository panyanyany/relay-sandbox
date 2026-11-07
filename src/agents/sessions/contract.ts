import type { DevelopmentSession } from "../../sessions/schema.js";
import type { SessionEventInput } from "../../sessions/events.js";

// 适配器只描述开发 Agent 的原生协议；Docker 传输与公共准入由会话层拥有。
export interface NativeSessionLaunchContext {
  session: DevelopmentSession;
  workspace: string;
  endpoint: string;
  model: string;
  environment: Readonly<Record<string, string>>;
}
export interface NativeProtocolMessage {
  method: string;
  params?: unknown;
  requestId?: string | number;
}
export interface NativeSessionAdapter {
  agent: DevelopmentSession["agent"];
  launch(context: NativeSessionLaunchContext): {
    command: string;
    args: string[];
    environment: Readonly<Record<string, string>>;
  };
  // 原生标识由协议回报，禁止把外部会话 UUID 当成已存在的原生历史。
  nativeSessionId(message: NativeProtocolMessage): string | undefined;
  events(message: NativeProtocolMessage): SessionEventInput[];
}
