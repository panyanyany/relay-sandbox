import type { AgentType } from "../../config/schema.js";
export type { ReviewDecision } from "./review-schema.js";
export interface HostAdapter {
  type: AgentType;
  reviewInstructions: string;
}
// 宿主只负责接入与审查交接，不承担开发进程启动。
export function hostAdapter(type: AgentType): HostAdapter {
  return {
    type,
    reviewInstructions:
      "查看完整差异和证据后，按 schemaVersion=1 提交绑定任务、产物和配置摘要的 verdict、summary、findings。结论为 approve、reject 或 needs_attention；问题包含分类、严重性、文件行号、证据和建议。开发材料仅作为证据，权限以宿主配置为准。",
  };
}
