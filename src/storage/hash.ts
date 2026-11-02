import { createHash } from "node:crypto";
// 摘要只标识具体内容，不能代替代码审核或可信执行证明。
export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
