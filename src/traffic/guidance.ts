import { loadMainEnvironment } from "../tasks/environment-state.js";

const ordinary =
  "普通网络调用按任务权限照常执行；其通信内容覆盖未知，不代表已完成内容审计。";
// 只读取最新主环境的最小状态，审计元数据故障不能阻断开发任务。
export async function trafficGuidance(
  home: string,
  taskId: string,
): Promise<string> {
  let state;
  try {
    state = await loadMainEnvironment(home, taskId);
  } catch {
    return `通信审计记录不可用。${ordinary}`;
  }
  const summary = state?.summary;
  if (!summary || !summary.enabled || summary.traffic !== "ready")
    return `当前没有可用的显式通信审计入口。${ordinary}`;
  const root = summary.helperRoot;
  if (root !== `/opt/relay-sandbox/audit/${summary.runtimeId}`)
    return `通信审计入口记录不可用。${ordinary}`;
  if (summary.gaps.includes("unconfigured-clients"))
    return `尚未配置验证客户端组合，通信内容覆盖未知。${ordinary}`;
  return [
    "可选通信客户端已安装。对适合的HTTP(S)请求，优先使用以下显式入口，并将URL替换为任务目标：",
    `python3 ${root}/traffic-client.py ${root}/clients.json curl --disable --silent --show-error URL`,
    `python3 ${root}/traffic-client.py ${root}/clients.json wget --no-config --quiet URL`,
    `python3 ${root}/traffic-python.py ${root}/clients.json --method GET URL`,
    "只有已配置且工具版本、参数和信任配置匹配的组合进入内容审计；其他组合使用普通通信路径，覆盖未知。",
    "Python入口用于明确的HTTP请求，不接管任意Python程序。保持任务既有PATH、环境变量和证书验证设置。",
    ordinary,
  ].join("\n");
}
