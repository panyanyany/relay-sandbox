// 归档大小不代表落盘大小：硬链接展开必须再次计入同一累计预算。
export const DEFAULT_EXPORT_BYTES = 8 * 1024 * 1024 * 1024;
export const DEFAULT_EXPORT_ENTRIES = 200000;
export interface ExportLimits {
  maxExportBytes?: number;
  maxExportEntries?: number;
}
export class ExportBudget {
  private bytes = 0;
  private entries = 0;
  constructor(private limits: ExportLimits = {}) {}
  entry() {
    if (
      ++this.entries > (this.limits.maxExportEntries ?? DEFAULT_EXPORT_ENTRIES)
    )
      throw new Error(
        "导出条目超过总量上限，请调整 resources.maxExportEntries",
      );
  }
  reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("导出文件大小非法");
    if (
      bytes >
      (this.limits.maxExportBytes ?? DEFAULT_EXPORT_BYTES) - this.bytes
    )
      throw new Error(
        "导出展开容量超过总量上限，请调整 resources.maxExportBytes",
      );
    this.bytes += bytes;
  }
}
