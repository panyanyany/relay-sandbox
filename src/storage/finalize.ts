// 清理失败保留主错误；两者都失败时提供完整 AggregateError。
export async function withFinalizer<T>(
  operation: () => Promise<T>,
  finalize: () => Promise<void>,
): Promise<T> {
  let primary: unknown,
    failed = false;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    try {
      await finalize();
    } catch (cleanup) {
      if (failed)
        throw new AggregateError([primary, cleanup], "操作与收尾均失败", {
          cause: primary,
        });
      throw cleanup;
    }
  }
}
