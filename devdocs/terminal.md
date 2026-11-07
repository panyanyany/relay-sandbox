# 使用独立终端和接入 Webcoding

在已注册的项目目录运行 `relay` 或 `relay-sandbox`，以逐行输入与容器中的开发 Agent 对话。开发 Agent 由项目配置选择 Codex、Claude Code 或 OpenCode。终端不再启动宿主协调 AI。原有 CLI 和 MCP 委派流程保留。

状态（2026-11-07）：统一输入已通过两仓全量检查、代码双审及真实CLI/测试容器/隔离网页的本机合成接口验收。专用真实模型配置仍缺，真实模型验收及发布阻塞。旧原生界面的失败记录保留为历史，不代表当前结构化入口的验证结果。验证范围见[实现验证记录](implementation-validation.md)和[验收清单](../.rope/issues/direct-terminal/e2e.md)。

## 启动和继续会话

先按[运行说明](usage.md)构建、注册项目并配置开发档案。开发执行需要 Docker 开发镜像和对应 CLI。终端使用普通逐行输入和滚动输出，不接管原生全屏界面，不要求 TTY，也不回退到原生界面。

```sh
relay-sandbox --cwd /path/to/project
relay-sandbox --cwd /path/to/project --session <会话UUID>
```

打开新入口只读取授权配置。空输入、`/help`、`/status`、`/skills` 和 `/capabilities` 不创建正式会话、任务或容器。未初始化 Agent 时，技能和能力查询明确提示暂不可用，不发送暖机提示词。空查看后退出只清理该入口登记的专属资源。

首个有效消息或技能请求先原子保存外部 UUID、会话元数据及 `accepted` 首请求记录，再通告身份、准备环境和派发。保存失败不执行 Agent；准备或执行失败保留正式记录和诊断。`accepted` 表示可靠接收，不保证执行成功，也不允许自动重放。后续开发请求同样先保存再执行。

正式会话固定项目真实目录、开发 Agent、任务和原生上下文。终端和网页使用相同状态目录与外部 UUID，续接同一上下文，不按客户端分配会话。不能把 Codex 线程 ID 或旧版宿主协调会话 ID 当成开发会话 ID。旧历史保留，但不会自动迁移成新的原生上下文。

## 输入消息、命令和技能

输入普通文字提交开发请求。统一命令如下，终端和网页共用解析规则：

| 输入 | 行为 |
| --- | --- |
| `/help` | 查看命令 |
| `/status` | 查看当前状态 |
| `/exit` | 离开观察，保留已接受的后台工作 |
| `/stop` | 显式停止当前会话执行 |
| `/review` | 显式运行独立审查 |
| `/skills` | 查询当前 Agent 的原生技能列表 |
| `/skill <name> [args]` | 按真实支持情况调用原生技能 |
| `/capabilities` | 分别查询技能发现和调用能力 |

未知斜杠命令和以 `!` 开头的直接 shell 输入会报错，不交给 Agent 执行。需要开发 Agent 运行工具时，用普通消息描述任务。等待输入不等于忙碌；执行中的新提交立即拒绝，不排队、不抢占。

技能来自所选 Agent，不建立另一套技能管理器。Codex 使用原生技能查询和结构化技能输入执行。Claude Code 只在实际初始化消息提供技能字段后列出；OpenCode 使用原生技能查询接口。Claude Code 和 OpenCode 的独立技能调用尚未支持，会明确报错，不把技能内容拼接成提示词冒充调用。切换 Agent 时技能列表可以不同，同一正式会话不能更换 Agent 身份。

## 退出、停止和恢复

输入 `/exit`、关闭终端、EOF、SIGINT 或关闭网页只断开观察，已接受的轮次和审计继续。命令行显式停止使用 `relay-sandbox session-stop <会话UUID>`。没有正式会话时停止和审查会报错。

异常退出保留可用证据和待审状态，不自动重放提示词。故障后先执行 `session-stop`；确认所有任务写入者停止后才释放故障后台的开发租约。清理失败保留诊断。恢复使用 `relay-sandbox session-resume <会话UUID>`，先核对旧进程死亡及容器停止，再沿用同步机制恢复。

恢复成功还要求结构化 Agent 后台和同一原生历史真实就绪。容器 running 或元数据存在不足以证明成功。缺历史或初始化失败直接报错，不发送提示词探活、不另建线程替代，也不重放不确定是否已执行的请求。

容器退出由 Docker 原生等待事件记录，厂商长驻后端异常也进入中断；退出码 137 不能单独证明 OOM。持久故障事实使旧报告失效，迟到的完成不会将其改回空闲。遗留锁需要确认原进程和写入者状态，不能直接删除。

项目默认直接挂载，开发修改立即生效，审查不能自动回滚。需要独立副本时选择 `isolated`，见[项目访问方式](project-access.md)。

## 显式审查

审计和资源指标在后台持续收集，AI 审查只在用户执行以下命令时发生：

```sh
relay-sandbox review <会话UUID>
relay-sandbox review <会话UUID> --json
relay-sandbox review <会话UUID> --evidence <固定证据UUID>
```

审查由宿主上独立配置的 CLI Agent 执行。先取得会话操作锁，暂停任务归属容器，固定代码、日志和摘要，再按配置运行检查和独立审查。冻结持续到报告保存及通知结束。代码正确性与运行行为分别评价；行为风险不会自动否决正确代码。

宿主可信状态目录中的 `review.yaml` 指定审查 Agent 和独立档案：

```yaml
agent: codex
profile: trusted-review
runtimeReview: true
timeoutMs: 120000
maxInputBytes: 1048576
```

`profiles/trusted-review.yaml` 使用[模型档案格式](usage.md)，其协议必须匹配审查 Agent。档案和凭据变量均须独立于开发配置，密钥不能相同。审查密钥不进入开发容器。缺配置、超时、非法 JSON、材料超预算或检查器不可用，都返回“审查未完成”，不自动借用开发密钥。

`delivery.aiReview` 控制代码 AI 审查，`runtimeReview` 控制行为 AI 审查，`delivery.checks` 控制配置检查。两轴关闭时明确记为未执行。材料预算超限不会静默截断后声称完整审查。报告只证明固定时间点的证据；容器恢复运行后，后台活动不属于已审快照。

固定证据补审不重跑开发。新开发或显式恢复会产生待审版本，旧报告不能将新内容标为已审。审查失败和历史报告均保留。直接挂载时，容器暂停无法阻止其他宿主进程写项目，这一覆盖缺口须保留在报告中。

旧任务交付审核继续使用 `review <任务UUID> --file decision.json`，与会话审查明确区分。

## 接入其他前端

JSONL 使用标准输入发送结构化请求，不把提示词放进命令参数：

```sh
printf '%s\n' '{"request":{"type":"message","prompt":"检查当前项目"}}' | relay-sandbox chat --cwd /path/to/project --json --input-json
```

输入格式共用可选的 `sessionId` 和 `after`：

```json
{"request":{"type":"message","prompt":"继续"},"sessionId":"外部UUID","after":42}
{"request":{"type":"skill","name":"skill-name","args":"参数"},"sessionId":"外部UUID"}
{"command":"status","sessionId":"外部UUID"}
{"command":"skills"}
```

每个 JSON 对象独占一行。`command` 支持 `help`、`status`、`skills`、`capabilities`、`exit`、`stop` 和 `review`。旧格式 `{"prompt":"继续","sessionId":"外部UUID","after":42}` 继续兼容，并经过统一命令解析。`after` 是已消费的事件游标，不是原生历史位置。

| 事件 | 含义 |
| --- | --- |
| `relay.session` | V2 外部 UUID 和开发 Agent；正式身份可靠保存后、耗时准备前返回 |
| `relay.accepted` | 后台已接受输入，不代表完成或通过审查 |
| `relay.readonly` | 查询或控制回执；新入口可没有 `sessionId`，不能据此绑定正式会话 |
| `relay.event` | 带会话、游标和时间的真实消息、工具、状态、审查事件 |
| `relay.gap` | 有界日志轮转造成的历史缺口 |
| `relay.error` | 明确失败；`phase` 区分 input、save、prepare、execute、observe、query 等阶段 |

真实增量尽力展示，不支持时显示完整消息。不从 ANSI 屏幕猜助手正文，不将完整消息拆成假流式。消息或工具事件投影不等于完整行为审计；缺失的工具事件应按覆盖缺口处理。

JSONL EOF 默认等待已接受轮次完成；逐行终端 EOF 立即离开观察。两者的中断都不发送停止命令。错误还需结合进程退出码和会话状态判断；已有会话中的后续输入错误可报告后继续。状态和历史可单独读取：

```sh
relay-sandbox session-status <会话UUID> --json
relay-sandbox session-events <会话UUID> --after 42
```

外部元数据、操作状态和有界事件位于状态目录 `sessions/<UUID>/`。原生聊天历史由相应 Agent 在开发环境中保存；事件日志有预算，不能宣称永远保留全部正文。删除环境前需保留所需证据。

## Webcoding 接入

构建 Webcoding 时设置 `RELAY_SANDBOX_ENTRY=/path/to/relay-sandbox/dist/src/cli/main.js`，运行时可用 `RELAY_SANDBOX_HOME` 指定状态目录。也可在服务 PATH 安装 `relay-sandbox`。

网页选择“中转沙箱”Agent。它调用同一个 CLI 和外部会话，不增加网页专用模型通道。共享 ID、状态、审查、停止和游标同步的最终验证见验收记录。当前不支持网页附件和 Plan 模式，使用项目内文件路径。

错误示范：将界面关闭当作停止；让旧宿主线程 ID 恢复开发；把完整消息包装成假增量；在开发容器放入审查密钥；以旧报告证明新版本安全；未经检查就删除遗留锁。

会话请求失败、取消审查等待及停止失败的处理见 [终端维护边界](terminal-maintenance.md)。
