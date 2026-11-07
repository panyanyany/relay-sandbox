/** Codex app-server 的 JSON-RPC 消息；通知和服务器请求仍由网关处理。 */
export type CodexRpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code: number };
};

/** 管理一次上游连接的请求关联，不接管事件串行化或会话生命周期。 */
export function createCodexRpc(send: (message: CodexRpcMessage) => void) {
  let sequence = 0;
  let closed: Error | undefined;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  return {
    request(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      if (closed) return Promise.reject(closed);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, ...(params ? { params } : {}) });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    /** 只消费响应；未知响应不影响其他请求，通知继续由网关处理。 */
    accept(message: CodexRpcMessage): boolean {
      if (message.id === undefined || message.method) return false;
      const id = Number(message.id);
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
      return true;
    },
    /** 首个断开原因保持不变，及时拒绝挂起及后续请求。 */
    close(error: Error) {
      if (closed) return;
      closed = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  };
}
