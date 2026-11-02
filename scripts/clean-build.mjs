import { rm } from "node:fs/promises";
// 清除过期构建模块，避免删除源码后旧入口仍被误用。
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
