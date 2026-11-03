import { AsyncLocalStorage } from "node:async_hooks";
const timeout = new AsyncLocalStorage<number>();
// 只给准备调用链设置30秒请求上限，不改变其他Docker操作的默认行为。
export function withPreparationDockerTimeout<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return timeout.run(30000, operation);
}
export function preparationDockerTimeout() {
  return timeout.getStore();
}
