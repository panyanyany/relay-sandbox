import type Docker from "dockerode";

// 共享 Docker 长等待覆盖空闲与执行期；不轮询，也不因前端离开重建后端。
export function watchDevelopmentContainer(
  container: Pick<Docker.Container, "wait"> & {
    inspect(): Promise<{ State: { OOMKilled: boolean } }>;
  },
  fail: (error: unknown) => Promise<void>,
) {
  const abort = new AbortController();
  let expected = false;
  let stopping: Promise<boolean> | undefined;
  // 停止期间先等结果：成功才取消监测，失败仍须记录容器退出。
  const isExpected = async () =>
    expected || (stopping ? await stopping : false) || expected;
  const completion = container
    .wait({ condition: "not-running", abortSignal: abort.signal })
    .then(
      async (result: { StatusCode: number }) => {
        if (await isExpected()) return;
        const details = await container
          .inspect()
          .catch(async (error: unknown) => {
            if (!(await isExpected()))
              await fail(
                new Error("开发主容器已停止，但无法读取退出证据", {
                  cause: error,
                }),
              );
            return undefined;
          });
        if (!details) return;
        if (await isExpected()) return;
        await fail(
          new Error(
            `开发主容器异常停止：exit=${result.StatusCode}，OOMKilled=${details.State.OOMKilled}；需要显式恢复，未自动重放模型请求`,
          ),
        );
      },
      async (error: unknown) => {
        if (!(await isExpected()))
          await fail(
            new Error("开发主容器退出通知不可用，无法确认后端健康", {
              cause: error,
            }),
          );
      },
    );
  // 保留可等待的失败，不把落盘错误变成未处理拒绝；调用方收尾必须等待。
  void completion.catch(() => {});
  return {
    completion,
    async duringStop<T>(run: () => Promise<T>): Promise<T> {
      if (stopping) throw new Error("容器停止操作正在进行");
      let settle!: (success: boolean) => void;
      stopping = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      try {
        const result = await run();
        expected = true;
        settle(true);
        abort.abort();
        return result;
      } catch (error) {
        settle(false);
        throw error;
      } finally {
        stopping = undefined;
      }
    },
    close() {
      expected = true;
      abort.abort();
    },
  };
}
