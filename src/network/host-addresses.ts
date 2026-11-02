import { networkInterfaces } from "node:os";
import { isIPv4 } from "node:net";

// 每次建任务重新取宿主地址；公网出口探测失败立即拒绝创建隔离环境。
export async function hostAddresses(): Promise<string[]> {
  const local = Object.values(networkInterfaces()).flatMap((list) =>
    (list ?? [])
      .filter((item) => item.family === "IPv4")
      .map((item) => item.address),
  );
  const response = await fetch("https://api.ipify.org", {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`宿主公网出口探测失败: ${response.status}`);
  const publicAddress = (await response.text()).trim();
  if (!isIPv4(publicAddress)) throw new Error("宿主公网出口探测返回非法地址");
  return [...new Set([...local, publicAddress])];
}
