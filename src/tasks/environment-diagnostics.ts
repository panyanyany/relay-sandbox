import { join } from "node:path";
import { formatError } from "../audit/redaction.js";
import { writeJson } from "../storage/files.js";
import { environmentDirectory } from "./environment-state.js";

// 每运行时、每阶段仅保留最近一次脱敏原因链；公开报告只引用稳定缺口代码。
export async function diagnoseEnvironment(
  home: string,
  taskId: string,
  runtimeId: string,
  stage: string,
  error: unknown,
): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage)) throw new Error("诊断阶段非法");
  try {
    await writeJson(
      join(
        environmentDirectory(home, taskId, runtimeId),
        "diagnostics",
        `${stage}.json`,
      ),
      {
        stage,
        time: new Date().toISOString(),
        error: formatError(error),
      },
    );
  } catch (failure) {
    // 诊断写盘失败也必须可见，但不能将可选观察故障升级为开发失败。
    process.stderr.write(
      formatError(
        new AggregateError([error, failure], "环境降级诊断写入失败"),
      ) + "\n",
    );
  }
}
