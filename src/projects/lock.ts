import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateId } from "./registry.js";
import { withFinalizer } from "../storage/finalize.js";

// 注册、配置、凭据及模板收尾共用排他边界；不能在保存档案后提前释放锁。
export async function withProjectSetupLock<T>(
  home: string,
  project: string,
  operation: () => Promise<T>,
) {
  validateId(project);
  const dir = join(home, "profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `setup-${project}.lock`);
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "项目配置正在操作；若进程已崩溃，请核对后移除对应setup锁文件",
        { cause: error },
      );
    throw error;
  }
  return withFinalizer(operation, () => unlink(path));
}
