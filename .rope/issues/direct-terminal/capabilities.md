# 终端直连能力探针

日期：2026-11-06。范围：本机真实 CLI、隔离临时配置、本地假 provider。没有真实模型调用，没有使用用户项目和凭据；下列“通过”仅指表中范围，不等于容器交付或付费模型 E2E 已通过。

## 运行可复用探针

```sh
pnpm exec vitest run tests/unit/native-session-probe.test.ts
pnpm exec tsx scripts/probe-native-sessions.ts
```

脚本创建临时 HOME、Claude 配置与本地 HTTP 服务，调用真实 Claude 结构化入口，验证 UserPromptSubmit 阻断后没有 `/messages` 模型请求，最后关闭服务并删除临时目录。脚本不继承用户环境凭据。`/api/hello` 等连接探测请求单独列出，不冒充模型调用。此脚本不验证 PTY，不能用它替代下列原生界面证据。

单测 Red：2026-11-06，探针模块尚不存在时测试失败。Green：新增模块后 2 项通过；真实脚本输出 `blocked=true`、`modelRequests=0`，原生 ID 与指定 ID 相同。定向 ESLint 与 `pnpm check` 通过。

## 已确认事实

| Agent / 版本 | 行为 | 结果与边界 |
| --- | --- | --- |
| Codex 0.162.1 | app-server 结构化两轮、重启后 thread/resume | 同一原生 ID；后续 Responses 请求包含首轮 nonce；有 thread/status/changed、turn/started、turn/completed 通知 |
| Codex 0.162.1 | resume --remote 真实 PTY | 原生屏幕和键盘输入确实连接现有 app-server；后续请求包含先前 nonce 和原生输入 |
| Codex 0.162.1 | 原生提交经 WebSocket 协议代理拒绝 | 真实 TUI 发出 turn/start；代理返回 busy 后原生显示 Failed to start turn，模型请求数不增加。这里只证明可拒绝入口，尚未集成共享原子锁及全部变更方法 |
| Claude Code 2.1.263 | 真实 PTY 的 UserPromptSubmit | exit 2 在模型请求之前拒绝；屏幕显示 hook 阻断，并保留指定原生 ID |
| Claude Code 2.1.263 | 原生执行中再次 Enter | 第二条 UserPromptSubmit 在首轮完成前触发；原子 mkdir 锁拒绝后仅首轮进入模型。无拒绝对照会排队并发送第二请求 |
| Claude Code 2.1.263 | 原生 PTY → 结构化 -p --resume | 退出原生进程后以同一 ID 恢复；请求包含首轮 nonce 和假响应 FAKE_ACK；输出 session_id 保持相同 |
| Claude Code 2.1.263 | 结构化轮 → 原生 PTY 再续接 | 同一 ID 再次 resume，真实原生键盘第三轮请求同时含首轮 nonce、结构化第二轮提示和第三轮提示；3 次 Stop 均完成 |
| Claude Code 2.1.263 | 前端断开，任务保留 PTY master | 真实 Unix socket 前端在假 provider 延迟响应期间关闭；原生进程保持存活，随后执行 Stop；完成后继续等待输入。不是关闭 PTY master 的测试，也不是宿主崩溃恢复 |
| Claude Code 2.1.263 | Stop 通知 | 原生轮与结构化轮完成均执行 Stop hook，含相同 session_id、last_assistant_message、background_tasks、session_crons |
| OpenCode 1.18.34 | serve、结构化入口 → 原生 attach | 原生第二轮实际 Responses 请求同时包含结构化首轮用户消息、首轮 FAKE_ACK 及原生第二轮；同一原生 ID |
| OpenCode 1.18.34 | 原生提交和状态 | 原生键盘经过 HTTP POST /session/<id>/message，status 实际 busy→idle；实际忙时原生第二次 Enter 发出 POST，代理立即 409 拒绝；首轮结束前关闭 TUI，serve 继续完成并保留同一原生会话 |

### 实施时必须保留的限制

- Codex 同时两个 app-server 加载相同线程会发生 active writer conflict。使用同一个任务自有后台 app-server，不能为终端和网页各自启动独立写入者。
- Claude 的阻断结果可能是进程退出 0、`result.subtype=success`、`is_error=false`、`num_turns=0`。必须结合 `prevent_continuation` 和准入事件识别拒绝，不能把这个结果投影成成功开发。
- Claude 默认原生界面允许排队。准入 hook 必须在提交时原子取得与网页及 review 共用的操作锁；只在模型请求时检查已经太晚。
- Claude 忙时第二条提交可能沿用首轮的 `prompt_id`。不能单凭该字段判断两个操作相同，不能让被拒绝的提交释放已有操作锁。
- 原生 CLI 可显示短暂 queued 提示，然后 hook 拒绝。中转沙箱需要明确呈现 busy 拒绝结果，不能保留为待执行输入。
- Stop hook 是轮次证据，不自动证明所有后台任务停止。审查固定证据前还要检查后台任务和写入边界。
- 本地假响应只证明实际请求携带上下文，不证明远程模型能理解或正确召回。真实模型语义另按已授权 E2/E3 执行。
- 尚未完成真实 Docker、连接断开存活、网页切换、重连输入互斥和独立审查的全链验收。不能将本表标成完整 S01/E1 通过。

## 本机证据位置

这些临时路径只用于本次调查，不属于跨环境运行要求。探针工程文件不保存任何真实凭据。

- Codex：`/tmp/relay-codex-native-W0W8S9/probe.json`；原生 remote：`/tmp/relay-codex-native-irqoLJ/probe.json`、`native-screen.txt`。由父执行者核对。
- Claude 原生拒绝：`/tmp/relay-claude-probe-4_z8dxah/hook.jsonl`；终端输出来自 `/tmp/relay-claude-tui-probe.py`。
- Claude 忙碌拒绝：`/tmp/relay-claude-probe-tg9740zx/hook.jsonl`；脚本 `/tmp/relay-claude-gated-busy-probe.py`。假 provider 延迟 8 秒，第二次提交在首轮响应前进入 hook，被原子目录锁拒绝。
- Claude 原生续接：`/tmp/relay-claude-probe-h2q_zgsz/`；脚本 `/tmp/relay-claude-resume-probe.py`。
- Claude 原生→结构化→原生完整往返：`/tmp/relay-claude-probe-6wkpu7xy/`；脚本 `/tmp/relay-claude-roundtrip-probe.py`。三轮均为本地假响应，不消耗真实模型授权额度。
- Claude 前端断开：`/tmp/relay-claude-probe-f6gd689s/`；脚本 `/tmp/relay-claude-detach-probe.py`。Unix socket 确实读到 EOF；工作进程保留 PTY master 并排空输出，原生进程在断开后完成轮次并保活。
- Claude Stop：`/tmp/relay-claude-probe-rzxq2wdh/stop.jsonl`；脚本 `/tmp/relay-claude-stop-probe.py`。
- OpenCode 初步实际接口：`/tmp/relay-opencode-probe-q7vbexkx/`；后续仅本地 Responses 入口试验位于 `/tmp/relay-opencode-probe-ifv74s0v/`。返回 Chat Completions SSE 会明确报协议不匹配；这不是 provider 能力通过证据。

## 待补证

1. 同一后台 native 服务的所有真实客户端输入，能否在进入执行前经过共享原子 gate；包括原生 TUI，不能只测试网页 API。
2. Claude Stop/失败/取消的锁释放不能互相覆盖，异常或后台子任务情况下仍需独立验证。
3. OpenCode 完整 SSE 通知和生产原子 gate 仍待集成；原生忙时立即拒绝、无排队重放及断开 TUI 后继续已经补证。
4. 全产品链中断开前端后，本轮执行和既有审计采集是否继续；异常退出证据缺口是否明确。Claude 原生 PTY 与任务自有传输的最小断开行为已经通过，不能替代产品集成验收。

## Codex 协议代理实施依赖

实际 Unix socket 握手返回 WebSocket 101；不是普通 JSONL socket。Node 内置 WebSocket 是客户端，现有依赖没有 WebSocket 服务端。建议采用成熟的 `ws`（registry 已核对 8.22.1）及开发类型 `@types/ws`（8.18.2），用于任务自有代理的客户端和服务端；不手写生产 WebSocket 帧解析。2026-11-07 用户已批准，两个精确版本已安装并写入锁文件；lint/check 通过。上游说明：[ws](https://github.com/websockets/ws)。

证据：`/tmp/relay-codex-native-7GPjbm/gate.jsonl` 记录实际原生 turn/start 和拒绝；同目录 `native-screen.txt` 记录错误展示，`probe.json` 只有先前两次假模型请求，原生被拒绝提交未追加模型请求。临时 Python 代理仅为本机探针，不是拟交付的运行依赖。

OpenCode 后续证据：`/tmp/relay-opencode-probe-fwztfxqs/traffic.json`、`calls.json`、`tui.screen`；调查汇总 `/tmp/relay-opencode-capability-result.md`。后续补证 `/tmp/relay-opencode-probe-t5cuhqks/`：实际原生忙时提交被409拒绝，未进入模型或排队重放；断开TUI后首轮完成。探针状态查询不是生产原子锁；测试进程已清理。合成协议证据选择性归档于忽略目录 `.local/evidence/direct-terminal/s01/`，不包含CLI缓存和运行socket。

## 2026-11-07 R01：首次执行准入阻塞

结论：**blocked，停止依赖片实施**。D19/C14要求原生命令也先保存正式会话再执行；现有Claude准入方案不能满足。此前普通提示的UserPromptSubmit拒绝证据仍有效，但不能推导`!shell`受控。本轮不修改功能，不以分类测试通过代替产品通过。

复现命令：

```sh
pnpm exec vitest run tests/unit/native-lifecycle-probe.test.ts
pnpm exec tsx scripts/probe-native-lifecycle.ts
```

探针使用真实Claude Code 2.1.263和系统PTY，临时HOME/配置/合成项目、假密钥及回环假接口。进入原生输入界面后提交`!echo lifecycle-probe > command-marker`。同时给UserPromptSubmit、UserPromptExpansion、PreToolUse、PermissionRequest、PostToolUse配置退出2的拒绝钩子。

实际结果：界面就绪；marker确实生成；上述钩子调用0次；本机假`/v1/messages`请求4次（503后的本机重试）；`gate=bypassed`，探针退出1。没有配置远程模型或继承真实凭据；模型请求只到本机假接口，不消耗G1远程模型额度。原生进程受控SIGTERM后退出143，已wait；HTTP监听已关闭，临时目录已删除。此退出是探针清理，不是产品异常崩溃。

另两次独立真实PTY实验分别只设置UserPromptSubmit和PreToolUse：均marker生成、钩子0次、本机假接口1次。完整本轮证据位于`.local/evidence/direct-terminal/lifecycle-r01/`：`claude-command.json`、`claude-pretool.json`、`claude-all-hooks.json`。前两次临时目录也已清理，进程已等待退出。脚本使用finally收尾；未操作Docker或用户项目。

已核对实际安装文件的hook事件列表，证据`installed-hook-events.txt`。列表有上述事件，但未发现独立的执行前shell/command事件；事件名称存在不证明`!`入口调用它。没有找到并实证可覆盖此入口的成熟钩子。后续需先解决原生可执行入口与C14的合同差距，不能依靠屏幕文本猜测、把打开算开发或禁用原生能力后宣称原合同通过。

本轮Codex/OpenCode完整生命周期未追加验证，原有证据仅维持原范围。Codex普通`--remote`首次打开的既有真实调查仍在`cold-lifecycle/`，不等于Docker产品恢复通过。因共同合同已出现明确反例，未继续扩大其他Agent探针。

验证：先新增测试导入不存在的模块，vitest失败；实现后2项通过，锁定“本地副作用不能被零模型请求掩盖”和“缺证保持unknown”。定向ESLint通过；pnpm check通过。两个源码/测试均少于500行，功能代码未变。

## 2026-11-07 U01：统一结构化入口补证

范围：真实安装Codex0.162.1、Claude2.1.263、OpenCode1.18.34；隔离HOME/合成项目、回环假Anthropic/Responses及假密钥，无TUI、Docker或远程模型。结果仅证明本机传输和上下文携带，不等于产品或真实模型验收。

```sh
pnpm exec vitest run tests/unit/structured-session-probe.test.ts
pnpm exec tsx scripts/probe-structured-sessions.ts .local/evidence/direct-terminal/unified-u01
```

| Agent | 实际创建、恢复与完成 | 原生技能能力及限制 |
| --- | --- | --- |
| Codex | app-server直接thread/start，turn/completed；重启app-server后thread/resume同ID，第二请求含首轮nonce。无需renderer或伪空历史 | skills/list有数据；合成SKILL.md通过turn/start的type=skill真实调用，完成通知存在，模型请求含技能marker；不是提示词拼接 |
| Claude | -p --session-id首轮假401持续api_retry，25秒上限收尾143；随后--resume同ID exit0/result，再次恢复含前轮nonce | system/init返回skills及slash_commands；尚未验证独立结构化技能执行，不把任意斜线输入认作已支持 |
| OpenCode | serve创建session、首message完成；结束并重启serve，同ID元数据和历史仍可读取；第二message完成、finish=stop，模型请求含首轮nonce | GET /skill及/command为200；列出不代表独立技能执行，skill工具调用尚未实证，可明确unsupported |

证据：忽略目录`.local/evidence/direct-terminal/unified-u01/`的result.json、各Agent.json、opencode-restart-metadata/messages.json。首轮first-result.json仅同serve续接；第二轮重启后POST超过20秒探针时限，不能记通过。最后一轮补齐假Responses的真实delta事件后重启续接通过，保留此前失败，不推断超时根因必然是产品缺陷。未再扩大补证轮次。

Claude首次失败保留会话ID并能resume，不意味着可自动重放已接受但执行状态不确定的请求。首次请求在本次注入中明确到达本地服务；143是探针超时清理，不是自然完成信号。空历史恢复、鉴权失败与业务完成必须分别判断。

脚本每RPC/HTTP有时限，CLI首轮有25秒限制；finally终止并等待自有进程组、关闭服务、删除临时目录。最终进程与临时目录已清理。U01a将隔离进程/假协议职责提取到structured-probe-support.ts；U01b为三Agent编排、证据分类和文档，各片小于约400差异行，源码测试少于500行。

红：新增测试导入不存在模块失败。绿：新增2项分类测试通过；定向ESLint和pnpm check通过。分类测试防止“只有ID/退出0就算恢复成功”，不替代以上真实CLI证据。旧原生!准入失败仍是历史事实，但D21自有结构化输入不经过该入口，不能继续视为当前方案阻塞。
