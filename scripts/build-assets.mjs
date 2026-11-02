import { mkdir, copyFile } from "node:fs/promises";
// 编译入口与源码入口使用相同辅助程序；只列出需要交付的受控脚本。
await mkdir("dist/scripts", { recursive: true });
for (const name of [
  "safe-apply.py",
  "traffic-client.py",
  "traffic-python.py",
  "decoy-install.py",
  "traffic-install.py",
]) {
  await copyFile(`scripts/${name}`, `dist/scripts/${name}`);
}
