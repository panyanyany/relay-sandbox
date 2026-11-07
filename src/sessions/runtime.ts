import { watchDevelopmentContainer } from "./backend-lifecycle.js";
import { readJson } from "../storage/files.js";
import { sessionPath, bindNativeSession } from "../terminal/session.js";
import { dockerClient } from "../docker/client.js";
import { withFinalizer } from "../storage/finalize.js";
import { formatError, redact } from "../audit/redaction.js";
import { developmentSessionSchema } from "./schema.js";
import { ensureSessionEnvironment } from "./environment.js";
import { startSessionAudit } from "./audit.js";
import { startSessionWorker } from "./worker.js";
import { createRuntimeDriver, developmentSecrets } from "./runtime-driver.js";
import { reviewSession, retrySessionReview } from "./review/report.js";
import { runSessionReviewChecks } from "./review/checks.js";
import { stopSession } from "./stop.js";
import { sessionEventInputSchema } from "./events.js";
// 入口只读取外部会话身份；创建容器、审计和原生进程都在取得 worker 归属以后。
export async function startDevelopmentSessionWorker(home: string, id: string) {
  const stored = developmentSessionSchema.parse(
    await readJson(sessionPath(home, id)),
  );
  const secrets: string[] = [];
  return startSessionWorker({
    home,
    id,
    secrets,
    driverFactory: async (controls) => {
      const prepared = await ensureSessionEnvironment(home, {
        cwd: stored.cwd,
        sessionId: id,
      });
      secrets.push(...developmentSecrets(prepared.env));
      let session = prepared.session;
      const docker = dockerClient();
      const audit = await startSessionAudit(
        home,
        session,
        prepared.task,
        secrets,
      );
      let stopped = false;
      let backendFailed = false;
      const fail = async (error: unknown) => {
        backendFailed = true;
        await controls.fail(error);
      };
      try {
        const driver = await createRuntimeDriver({
          home,
          prepared,
          docker,
          secrets,
          controls: {
            ...controls,
            fail,
            emit: async (event) => {
              const payload = Object.fromEntries(
                Object.entries(event.payload).map(([key, value]) => [
                  key,
                  typeof value === "string" ? redact(value, secrets) : value,
                ]),
              );
              return controls.emit(
                sessionEventInputSchema.parse({ type: event.type, payload }),
              );
            },
          },
          async bindNative(nativeId) {
            session = await bindNativeSession(
              home,
              id,
              {
                cwd: session.cwd,
                projectId: session.projectId,
                agent: session.agent,
              },
              nativeId,
            );
          },
        });
        if (!prepared.task.containerId) throw new Error("开发主容器身份缺失");
        const lifecycle = watchDevelopmentContainer(
          docker.getContainer(prepared.task.containerId),
          fail,
        );
        return {
          ...driver,
          review: async (evidenceId?: string) =>
            evidenceId
              ? retrySessionReview({ home, session, evidenceId })
              : reviewSession({
                  home,
                  session,
                  docker,
                  audit,
                  secrets,
                  runChecks: (evidence, checks) =>
                    runSessionReviewChecks(home, evidence, checks, docker),
                }),
          stop: async () => {
            if (!driver.stop) throw new Error("当前驱动未提供停止能力");
            await lifecycle.duringStop(() =>
              stopSession({
                home,
                session,
                driver: { stop: () => driver.stop!() },
                audit,
                ...(backendFailed
                  ? {
                      failedBackend: {
                        afterWritersStopped: controls.settleFailedOperation,
                      },
                    }
                  : {}),
              }),
            );
            stopped = true;
          },
          close: () =>
            withFinalizer(
              async () => {
                lifecycle.close();
                await lifecycle.completion;
                await driver.close?.();
              },
              async () => {
                if (!stopped) await audit.finish();
              },
            ),
        };
      } catch (error) {
        return withFinalizer(
          async () => {
            throw new Error(formatError(error, secrets));
          },
          async () => {
            await audit.finish();
          },
        );
      }
    },
  });
}
