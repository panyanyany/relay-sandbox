import { withProjectSetupLock } from "../projects/lock.js";
import type { Command } from "commander";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { loadConfig, loadProfile } from "../config/load.js";
import {
  saveCredential,
  readCredential,
  credentialSaveStatus,
} from "../config/credentials.js";
import { resolveProject } from "../projects/registry.js";

// 使用真实TTY隐藏输入；不接受参数或管道，避免密钥进入历史、进程参数或AI工具输出。
async function hiddenCredential(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("请在本机交互终端运行此命令；不接受密钥参数或管道输入");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once("SIGINT", () => reject(new Error("已取消凭据录入")));
      reader.once("close", () => reject(new Error("凭据录入已结束")));
      reader.question("输入专用中转密钥（不回显）：", (answer) =>
        resolve(answer),
      );
      muted = true;
    });
  } finally {
    reader.close();
    process.stderr.write("\n");
  }
}
// 命令只输出就绪状态，供已启动的MCP和后台任务按需读取私有文件。
export function registerCredentialCommands(
  program: Command,
  home: () => string,
) {
  program
    .command("credential-set <project>")
    .description("本机隐藏输入专用中转密钥，不通过聊天或命令参数传递")
    .action(async (project: string) => {
      const config = await loadConfig(await resolveProject(home(), project));
      const profile = await loadProfile(
        home(),
        config.developmentAgent.profile,
      );
      // 人工输入不持锁；保存前重新核对档案，避免输入期间配置切换后写错凭据。
      const key = await hiddenCredential();
      const update = await withProjectSetupLock(home(), project, async () => {
        const current = await loadConfig(await resolveProject(home(), project));
        const selected = await loadProfile(
          home(),
          current.developmentAgent.profile,
        );
        if (
          current.developmentAgent.profile !==
            config.developmentAgent.profile ||
          selected.apiKeyEnv !== profile.apiKeyEnv
        )
          throw new Error("输入期间项目档案已变更，请重新运行录入命令");
        await saveCredential(home(), selected.apiKeyEnv, key);
        return credentialSaveStatus(
          true,
          (await readCredential(home(), selected))!.source,
        );
      });
      console.log(
        JSON.stringify({
          project,
          credentialReady: true,
          credentialUpdate: update,
          restartRequired: false,
          note: "环境变量优先；已注入同名环境变量时仍使用该变量",
        }),
      );
    });
}
