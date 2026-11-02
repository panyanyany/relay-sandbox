import { defineConfig } from "vitest/config";
// 容器测试由显式环境变量启用，不将缺少 Docker 伪装成通过。
export default defineConfig({
  test: { testTimeout: 120000, hookTimeout: 180000, maxWorkers: 1 },
});
