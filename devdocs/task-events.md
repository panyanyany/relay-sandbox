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

实现使用 Node.js 文件系统事件监听任务目录，关注 `task.json` 的原子替换。后台 CLI 或其他进程保存任务时也能触发，不需要模型轮询。25 毫秒窗口内的通知可合并；通知是快照失效提示，不是可靠的逐事件日志，可能重复或丢失。需要完整行为证据时继续读取任务日志和审计分页。

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
