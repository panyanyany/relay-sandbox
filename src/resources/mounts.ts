import type Docker from "dockerode";
import type { FileResource, RuntimeOptions } from "../permissions/types.js";
// Docker API 支持 NonRecursive；当前 dockerode 类型尚未声明该字段。
interface PrivateBind extends NonNullable<Docker.MountSettings["BindOptions"]> {
  NonRecursive: true;
}
// 仅消费准备器验证过的资源，不接受任意 HostConfig 输入。
export function resourceMounts(
  resources: FileResource[],
): NonNullable<RuntimeOptions["mounts"]> {
  return resources.map((resource) => {
    const options: PrivateBind = {
      Propagation: "rprivate",
      NonRecursive: true,
    };
    return {
      Type: "bind",
      Source: resource.source,
      Target: resource.target,
      ReadOnly: resource.access === "read-only",
      BindOptions: options,
    };
  });
}
