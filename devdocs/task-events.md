# 订阅任务变化

状态：已实现服务端任务事件订阅。真实 stdio 客户端已验证跨进程任务更新、取消订阅与重连。Codex、Claude Code、OpenCode 是否消费通知并自动续接 AI 尚未验收；没有验证前继续使用 `wait_task` 或 `get_task`。

## 选择事件方式

1. 调用 `get_capabilities`，确认 `observation.eventHooks.supported` 为 `true`。
2. 客户端注册 `notifications/resources/updated` 通知处理器。
3. 调用 `subscribe_task_events`，参数为任务 `id`。也可通过协议 `resources/subscribe` 订阅 `relay-sandbox://tasks/<任务ID>`。
4. 订阅成功后立即调用 `get_task` 或 `resources/read` 读取同一 URI，取得当前 `revision`、`task` 和 `nextAction`。先订阅再读取，避免接入期间漏掉变化。
5. 收到通知后重新读取快照，按 `nextAction` 继续。通知只包含资源 URI，不包含项目内容或凭据。
6. 不再需要时调用 `unsubscribe_task_events`，或使用 `resources/unsubscribe`。取消订阅不停止任务。

资源模板通过 `resources/templates/list` 发现。工具入口便于宿主 AI 选择通知方式，但不会为不支持通知的客户端增加自动续接能力。任务创建、开发和交付入口保持不变。

## 理解投递范围

实现使用 Node.js 文件系统事件监听任务目录，关注 `task.json`、准备取消标记及任务租约文件的更新。后台 CLI 或其他进程保存任务时也能触发，不需要模型轮询。25 毫秒窗口内的通知可合并；通知是快照失效提示，不是可靠的逐事件日志，可能重复或丢失。需要完整行为证据时继续读取任务日志和审计分页。

每条 MCP 连接最多订阅 256 个不同任务。同一 URI 的并发订阅等待同一次初始化；校验失败时所有等待请求失败，不返回虚假的成功。未知任务和非法 URI 明确报错。失效记录也计入容量上限，取消后释放容量。取消或断开连接后释放监听器和定时器。监听或发送失败会停止该订阅并保留失效状态，写入宿主 stderr 的结构化诊断包含任务 URI、watch/send 阶段、是否为当前实例及脱敏错误链，不污染 stdio 协议。

订阅不持久化。断线后重新订阅并立即读取当前快照，不能依赖离线通知重放。资源删除、宿主文件系统丢失事件和服务器重启不保证交付通知。当前只订阅任务快照变化，不逐条推送流量、指标或审计事件。

当前 SDK 1.32.2 使用 `resources/subscribe` 和 `resources/unsubscribe` 协议。实现基于 [MCP 2025-11-25 资源订阅规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/resources.mdx)，不声称实现后续版本的 `subscriptions/listen`。

## 查询订阅状态与处理故障

调用 `get_task_event_subscription`，参数是任务 `id`。只查询当前连接，不创建订阅或触发重试。返回：

| state | 含义与操作 |
| --- | --- |
| `absent` | 未订阅或已取消；选择事件方式时先订阅，再读取快照 |
| `initializing` | 正在校验任务；并发订阅等待同一个初始化结果 |
| `active` | 服务端监听有效；不代表客户端已收到每条通知或能唤醒 AI |
| `failed` | 监听或发送失败，`failure.stage` 和 `failure.time` 给出阶段与时间；改用 `wait_task` / `get_task`，排查 stderr，修复后显式重订阅 |

订阅和取消工具也返回同一状态结构。`subscribed` 仅在 `active` 时为 true。成功重订阅后清除旧故障状态；不自动重试。客户端无法通过“持续没有通知”确认任务是否变化，应按自身调用预算查询订阅健康及任务快照。状态入口用于排障，不提供通知送达回执。

初始化被取消或连接关闭后不能再返回订阅成功；旧请求回滚或迟到故障不能移除新实例。失败记录最多随 256 个订阅保留，取消或断开连接会删除记录。

## 验证更新

运行：

```sh
pnpm exec vitest run tests/unit/task-subscriptions.test.ts tests/unit/task-events.test.ts tests/unit/mcp.test.ts
pnpm lint && pnpm check && pnpm test
pnpm build
```

`task-events.test.ts` 启动真实 stdio MCP，通过独立 Node.js 进程原子替换任务文件，验证收到更新后能读取新状态、取消后停止接收、重连不继承订阅，以及工具订阅入口恢复通知。此测试不调用计费模型或启动 Docker。

`task-subscriptions.test.ts` 使用可控监听器、初始化读取和 SDK 内存传输，独立验证并发失败与重试、旧实例回滚隔离、监听和发送失败、容量限制，以及进程不退出时的断线清理。

## 等待环境准备

`start_task` 冻结项目配置、模型档案和宿主授权后，派发独立宿主进程准备环境，立即返回 `id`、`taskId`、`workerPid`、任务快照及 `revision`。复制项目、准备资源、启动容器和安装审计不占用原 MCP 调用。创建入口不会自动运行开发 Agent。

按 `nextAction` 续接：

| 状态与标记 | 下一步 |
| --- | --- |
| `preparing`，`environmentReady=false` | 订阅更新，或用 `wait_task` 有界等待；不要调用 `run_task` |
| `prepared`，`environmentReady=true` | 环境准备完成，调用 `run_task` |
| `failed` | 查看错误和日志，收尾并上报；不能把部分容器当作已就绪环境运行 |

`get_task`、`wait_task` 和资源读取均返回 `environmentReady`。新任务即使已有容器编号，也必须等全部准备步骤完成。旧任务缺少该标记时，兼容已有容器的判断方式。后台准备持有可刷新的任务租约；准备完成后释放租约，`prepared` 不按遗留准备任务回收。网络监督仍覆盖准备完成、等待开发的环境。

准备期间运行请求立即拒绝，不会把任务改成 `queued` 或 `failed`。调用 `cancel_task` 可提交准备取消请求；返回 `cancellationRequested=true` 只表示已受理，须继续等待 `stopped` 或 `failed` 后再清理。取消写入独立的 `preparation-cancel.json`，不受旧任务快照覆盖。文件扫描及分块复制通过 AbortSignal 中止；准备调用链的 Docker 请求使用 30 秒超时，取消可能等待当前请求和资源收尾，不承诺瞬间完成。收尾失败返回 `failed` 并保留原因链，不能假报全部停止。清理仍与准备互斥，避免目录删除后后台继续创建资源。进程失联仍由独立监督器处理。

任务写入 `prepared` 后仍需完成租约交接；查询快照会在锁释放前保持 `environmentReady=false`、`nextAction=wait_task`。锁释放改变游标并触发订阅通知。交接竞态中的派发返回 `status=busy`、`nextAction=wait_task`，不将预期忙碌当作文件系统错误。

后台派发失败返回 `status=failed`、`stage=dispatch`、任务 ID 及脱敏错误链，可继续查询、清理和上报。任务预约之前的输入、配置和凭据错误仍直接报错。首次准备未完成的部分环境不能通过普通恢复放行，应清理后重新创建。完整环境恢复成功进入 `prepared`。

MCP 客户端的等待调用超时或取消，只结束等待，不停止后台准备，也不代表环境已就绪。不要因等待超时直接重复创建任务；先用已返回的任务 ID 查询。

CLI `start` 保留同步准备再启动的行为。内部 `initialize-task <id>` 只准备已有冻结任务，供后台派发使用；不重新加载项目配置或宿主授权。

持续高内存提醒通过任务根目录 `resource-pressure.json` 发布。进入或退出高压会改变 `resourceWarnings` 与版本游标，并触发订阅通知。提醒不等于任务结束，也不自动中断开发进程；处理方式见[资源观察](observability.md#预防并排查退出码-137)。
