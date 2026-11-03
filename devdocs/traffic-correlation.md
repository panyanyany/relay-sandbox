# 从诱饵命中追溯受控调用

日期：2026-11-02。本功能只覆盖已配置、兼容的 curl、wget 和 urllib 显式审计入口。诱饵仍默认关闭。不采集业务调用栈，也不承诺归因任意程序的通信。

## 启用并读取记录

1. 按[行为策略](behavior-policy.md)在宿主授权文件中启用诱饵并配置已验证客户端。
2. 重新构建观察镜像和 CLI。启动检查会核对关联协议模块版本，旧镜像不满足时只降级审计，不安装会发送内部头的新入口。旧的运行中代理不会自动加载新脚本；停止并恢复任务以创建新观察环境，或创建新任务。恢复使用原冻结授权，不能通过恢复启用原先关闭的诱饵。

   ```sh
   docker build -f images/traffic.Dockerfile -t relay-sandbox-traffic:0.1.0 .
   pnpm build
   ```

3. 使用宿主提示给出的显式客户端入口执行请求。普通 curl、wget 或任意 Python 程序不会因此自动获得进程关联。
4. 读取 `get_result.policy.traffic.events`，或宿主任务目录的 `traffic/<运行时>/evidence/events.jsonl`。`report_task` 的文字摘要展示最多 10 条命中的关联信息。

## 理解关联字段

| 字段 | 来源和含义 |
| --- | --- |
| `runtimeId` | 宿主汇总时根据证据所在目录补充；原始日志通过目录定位环境 |
| `host`、`port` | 代理观察到的请求目标，不保存完整 URL、查询参数或请求片段 |
| `invocation.invocationId` | 入口每次调用生成的 UUID；重试或重定向可属于同一次调用 |
| `invocation.requestId` | 代理为每个 HTTP 请求独立生成的 UUID；同一请求的多个命中共用 |
| `invocation.tool` | `curl`、`wget` 或 `python` |
| `invocation.pid`、`parentPid` | 入口声明的容器内 PID、父 PID，父进程不在命名空间内时可为 0 |
| `invocation.processStartTicks` | 入口读取 `/proc/self/stat` 的进程启动 tick；结合环境和 PID 辅助区分 PID 复用 |
| `invocation.startedAt` | 入口收集声明的 UTC 时间，不是内核证明的请求发出时间 |
| `invocation.executable` | 受控入口声明的目标程序路径，不是宿主核验的可执行文件身份 |
| `invocation.source`、`pidNamespace` | 固定为 `client-reported`、`container`，说明证据来源及 PID 范围 |

curl/wget 入口通过 exec 启动目标工具，因此沿用入口 PID 和进程启动 tick。urllib 请求由入口自身发送。记录不包含完整命令参数、环境变量、请求正文、真实密钥或完整 URL。

## 判断证据强度

入口通过保留的内部请求头传递最小进程声明。代理在 [requestheaders 钩子](https://docs.mitmproxy.org/stable/api/events.html)中读取并删除该头，再观察和转发请求。内部头不会转发到目标网站。每份声明最多 2048 个编码字符、解码后最多 1024 字节，只接受固定字段。

声明来自沙箱，恶意程序可以伪造或重复使用。请求编号由代理生成，但不能据此证明声明的 PID 就是真实发送进程。该关联用于排查线索，不是内核验证的进程归因、完整父子进程链、进程数量或业务调用栈；容器 PIDs 计数仍来自独立定时指标。命中也不能证明远端收到，更不能单独判定恶意。

错误示范：仅根据时间接近拼接命中和进程；把容器 PID 当成宿主 PID；把客户端声明写成“内核确认”；或者保留内部头并将进程元数据发送到目标站点。

## 处理缺失和旧记录

旧事件没有 `invocation` 字段时仍可读取，报告明确显示未关联发送进程。直接使用代理但没有内部头的请求也不强行归因。重复、超限或格式错误的内部头会被删除，代理记录 `invocation-context-invalid` 缺口，不保存头原文，也不阻断正常请求。

入口读取进程标识失败时，在 stderr 输出固定的 `process-context-unavailable` 原因，继续既有代理请求，不进行直连重放；命中可能没有关联。现有流量轮转、4 MiB 汇总预算、20000 条解析预算和报告保留期继续适用，不增加独立的无界调用日志。

## 验证记录

验证入口：`tests/unit/traffic-context.test.ts`、`tests/integration/traffic-clients.test.ts`、`tests/integration/traffic-python.test.ts`、`tests/integration/traffic-proxy.test.ts`、`tests/e2e/policy-traffic.test.ts`。分别检查字段边界、旧事件兼容、真实 HTTP/TLS、上游不接收内部头、坏头降级、调用与请求编号、宿主结果及最终报告。本轮 `pnpm lint && pnpm check && pnpm test && pnpm build` 全部通过：72 项通过，43 项按显式开关跳过。开启 `RELAY_DOCKER_TEST=1` 后，四个相关 Docker 集成用例和一个实际 CLI/MCP 端到端用例通过。最终构建的 CLI 帮助命令通过冒烟检查，观察镜像已重新构建。此次未调用真实计费模型，也未验证任意进程或业务调用栈归因。

## 核对代理就绪

启动时通过实际代理向同一网络命名空间的本地随机端口发送探针。探针携带有效内部关联头，端点要求该头已被剥离，并返回随机标识供调用方核对。只检查模块版本或端口监听不足以确认请求钩子生效。

探针不访问公网、不携带诱饵或业务内容。失败时不安装新的显式审计入口，代理启动路径清理运行资源和私密材料，由环境安装流程记录覆盖缺口。普通通信仍遵守已有网络边界。
