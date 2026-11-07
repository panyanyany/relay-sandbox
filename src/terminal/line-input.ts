import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

// readline只拆行，不接管raw mode或清屏；退出只关闭本客户端的读取器。
export async function* terminalLines(input: Readable, signal?: AbortSignal) {
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const close = () => reader.close();
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  try {
    for await (const line of reader) {
      if (signal?.aborted) break;
      yield line;
    }
  } finally {
    signal?.removeEventListener("abort", close);
    reader.close();
  }
}
