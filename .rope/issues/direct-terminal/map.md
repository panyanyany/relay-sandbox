# 终端直连：实现定位

当前实现以末节“U22清理后的定位”及devdocs/structure.md为准。下列按实施顺序保留历史，不能把同日较早条目或已删除路径当成当前能力；未知项不可当作已有能力。

## S/R历史定位（已由统一输入迁移替代）

- 2026-11-06：`.rope/routes.md` 指定 host-managed，架构说明沿用 `devdocs/`，不自动提交或推送。
- 2026-11-06：本仓库没有 `.rope/CONTEXT.md`、`.rope/specs/`、`.rope/adr/`、`.rope/research/`；本次决定来源为 `grill-decisions.md` 及已有 devdocs，不重复初始化框架。
- 2026-11-06：`src/terminal/host.ts` 启动宿主 Codex，通过 MCP 委派开发；这是本次需要替换的终端职责，不是沙箱直接对话。
- 2026-11-06：`src/terminal/session.ts` 保存 version=1、host=codex 及宿主 nativeId；不能把这些旧 nativeId 当作沙箱开发线程。
- 2026-11-06：`src/terminal/turn.ts` 转发宿主事件，取消时按 terminalSessionId 停止任务；目前断开存活和独立审查不符合新合同。
- 2026-11-06：`src/terminal/command.ts` 提供逐行交互及 stdin JSON 单轮入口，没有原生 TUI 透传。
- 2026-11-06：`src/agents/development/contract.ts` 的 DevelopmentAdapter 只有单轮 launch，没有原生会话生命周期或输入事件接口。
- 2026-11-06：`src/agents/development/codex.ts` 使用 Codex exec --json；没有现成沙箱原生 TUI 启动及 resume 映射。
- 2026-11-06：`src/agents/development/claude-code.ts` 当前使用 claude -p --output-format json；本地 CLI help 支持 --session-id、--resume、stream-json、--include-partial-messages，实际组合需验证。
- 2026-11-06：`src/agents/development/opencode.ts` 当前使用 opencode run --format json；跨原生终端续接与状态信号尚未验证。
- 2026-11-06：本机 Codex resume --help 支持显式 SESSION_ID；仅有帮助信息不能证明终端与结构化模式的完整上下文互通。
- 2026-11-06：`src/docker/execute.ts` 不接收 stdin、不分配 TTY，持续排空但将有界输出收集到结束后返回；超时停止整个容器，不能直接充当新交互传输层。
- 2026-11-06：`src/tasks/dispatch.ts` 已用 detached 子进程、日志及 unref 派发后台操作，可复用任务进程模式；不等于原生终端已经断线续跑。
- 2026-11-06：`src/tasks/run.ts` 启动审计并在运行收尾保存 audit.json/分轮审计；新会话不能绕过该证据链或每个客户端各启动一套采集。
- 2026-11-06：`src/tasks/create.ts` 及 `src/tasks/types.ts` 已增加 terminalSessionId，用于旧终端关联任务；它不替代稳定的沙箱会话原生身份映射。
- 2026-11-06：`src/tasks/lock.ts` 及 `src/storage/files.ts` 已有任务互斥和原子写入，新增会话互斥应优先复用成熟模式。
- 2026-11-06：`src/cli/main.ts` 的 review <id> 当前要求 --file，调用 reviewTask 提交审核 JSON；必须与新会话 review 保持明确兼容。
- 2026-11-06：`src/agents/host/contract.ts` 只提供审核指令；不能把它当作现成独立审查模型执行器。
- 2026-11-06：`devdocs/project-access.md` 规定 direct 即时影响原项目，审核拒绝不自动回滚；isolated 沿用先候选后应用。
- 2026-11-06：`devdocs/review.md` 要求结构化审核及摘要绑定；模型输出文本关键词不能替代 Schema 校验。
- 2026-11-06：`devdocs/user-reporting.md` 区分报告生成与实际输出回执；新入口不能用保存文件冒充用户已收到。
- 2026-11-06：Webcoding 的 `srv/relay-runtime.ts` 调用本项目 chat --json --input-json，保存独立 relay context；目前仍间接启动宿主协调器。
- 2026-11-06：Webcoding 的 `srv/codex-app-server.ts` 已处理文本 delta、thread/resume、turn/start；可参考协议及消息投影，不应为沙箱另建宿主模型调用通道。
- 2026-11-06：Webcoding 的 `lib/agent-runtime.js` 有 Claude stream-json 启动及 --resume；完整 assistant 消息投影不能单独证明真实文本增量。
- 2026-11-06：Webcoding 的 `srv/process-runtime-controls.ts` 为旧 relay 协调器设 60 秒停止宽限；新入口要区分停止前端和停止共享开发会话。
- 2026-11-06：Webcoding 的 `srv/agent-history.ts` 保留 relay 原生历史和证据；删除网页映射不等于删除沙箱环境。
- 2026-11-06：`tests/unit/terminal*.test.ts` 现有证据使用合成宿主进程；未证明真实 Agent 原生 TUI、跨模式续接和网页切换。
- 2026-11-06：两个工作区均有上一轮已测试、未提交的修改；实施须保留，不以清理工作区为由覆盖。

- 2026-11-06：实际 Codex 0.162.1 remote TUI 可以恢复 app-server 原生上下文；Unix socket 采用 WebSocket 握手，原生 turn/start 可被协议代理拒绝并在原生界面显示 busy，模型请求不增加；证据见 capabilities.md。
- 2026-11-06：实际 Claude Code 2.1.263 支持原生与结构化同原生ID双向恢复，UserPromptSubmit 可在执行中第二次提交时原子拒绝，Stop 提供完成证据；保留PTY master 的任务工作进程可在前端断连后完成当前轮。

- 2026-11-07：OpenCode真实attach在busy期间原生POST可被409拒绝，无重放；断开TUI后serve完成首轮。证据 `.local/evidence/direct-terminal/s01/opencode-finish/`；生产需原子gate而非探针status再转发。
- 2026-11-07：package.json/pnpm-lock.yaml已按用户批准锁定ws8.22.1和@types/ws8.18.2，Unix socket客户端/服务端本机往返通过。

- 2026-11-07：src/sessions/schema.ts定义V2开发身份；src/terminal/session.ts保留V1并新增create/readDevelopmentSession及bindNativeSession/bindDevelopmentEnvironment。metadata.lock独立于后续operation锁，ephemeral以task.id作逻辑environmentId。

- 2026-11-07：实际Codex generate-json-schema导出ClientRequest（临时/tmp/relay-codex-protocol-schema-20261107）；除turn/start外，thread/shellCommand、thread/compact/start、review/start、command/exec、fs/writeFile等也可执行/变更。S09代理需按只读白名单与变更准入分类，不能只锁聊天。

- 2026-11-07：sessions/operation.ts acquire/release/withSessionOperation持原子token锁，拒绝不抢锁；state.ts开发准入即evidenceVersion++，updateSessionState仅持锁操作，prepare/stop可清除中断；调用失败留下写入者时调用方须先明确标interrupted再释放。

- 2026-11-07：sessions/event-store.ts appendSessionEvent/replaySessionEvents提供同进程串行、跨进程显式排他、JSONL高水位/轮转gap；agents/sessions/contract.ts提供轻量launch/nativeSessionId/events适配边界。

- 2026-11-07：sessions/environment.ts ensureSessionEnvironment(home,{cwd,sessionId?})复用reserveTask/prepareTask并返回session/task/profile/env；profile.ts只读任务冻结开发档案，terminal/session.ts bindDevelopmentTask在准备前受控保存归属。

- 2026-11-07：sessions/worker.ts startSessionWorker暴露统一acquireNativeOperation/completeNativeOperation；worker-api.ts一次一应答status/events/submit/stop，dispatch.ts detached spawn并核对新workerPid，尚待S17装配session-worker入口。

- 2026-11-07：sessions/audit.ts startSessionAudit仅供worker所有者，snapshot不终止、finish幂等；audit/collector.ts增加可选snapshot并检测运行中退出。
- 2026-11-07：docker/interactive.ts提供TTY/stdio与真实completion；sessions/transport.ts持续排空和有界screen回放，attach.ts处理rawmode/resize；瞬时input guard不代替vendor原子执行gate。

- 2026-11-07：Claude hook与容器AI同UID，nonce不等于对抗伪造安全边界；C13正常输入共用准入，S14宿主Docker pause承担取证写入隔离，报告必须限定固定快照，不宣称后续运行已审。

- 2026-11-07：sessions/review/evidence.ts withReviewEvidence(home,session,{docker,audit,secrets?},callback)固定版本和摘要，review租约及pause持续callback；snapshot.ts复用direct snapshot/isolated download与预算，恢复失败标interrupted。

- 2026-11-07：codex-driver.ts createCodexDriver包装容器app-server与私有Unix WS gateway；nativeLaunch仅host远程renderer，turnID/threadID匹配结束，未知变更拒绝。
- 2026-11-07：claude-driver.ts createClaudeDriver通过容器Node broker与hook协作准入；空TUI不绑定，首次获准prompt后bindNative；native()/submit串行关闭空闲旧进程后严格resume同ID，不静默新建已有历史。

- 2026-11-07：worker.driverFactory仅在worker.lock独占后执行，初始化成功才发布控制socket；runtime.ts装配一次审计与三厂商driver，native/review通过相同worker RPC。
- 2026-11-07：environment.ts新增openDevelopmentSession，只读授权身份可先返回UUID；ensureSessionEnvironment才准备容器。OpenCode冻结env含serve默认model。
- 2026-11-07：review/config.ts独立宿主review.yaml；cli.ts使用真实受限CLI；report.ts取证与模型期间冻结，state.ts固定材料补审验证摘要，新版本不会被旧报告标已审。
- 2026-11-07：native-channel.ts及terminal/native-input.ts提供私有帧通道，断开仅结束前端。terminal/frontend.ts的Codex远程renderer用隔离HOME不含凭据。
- 2026-11-07：Webcoding relay-runtime.ts/relay-session-link.ts使用V2外部UUID和持久cursor，拒绝V1宿主映射，投影真实语义事件；终端用户历史补入在S19收口。

- 2026-11-07：tasks/environment.ts的environmentConfigDigest合并项目与冻结policy摘要，freeze及独立review共用；不得用项目单独摘要替代。
- 2026-11-07：terminal/session.ts的parseDevelopmentSession统一V1错误诊断，openDevelopmentSession先读取Agent时也走该契约。
- 2026-11-07：worker事件落盘边界统一脱敏；review/cli.ts复用有界原生error提取，非零及exit0错误都保留实际原因。
- 2026-11-07：Webcoding只读历史与live采用活动entry单写者，空闲导入user/assistant/tools，活动时只观察；UI在app入口显式装配，协议初始化无DOM副作用。
- 2026-11-07：docker/interactive.ts的createExec和exec.start均传相同Tty；Codex空thread冷bootstrap按真实空历史答复resume/read/turns-list，任何执行前失效。

- 2026-11-07：sessions/backend-lifecycle.ts以Docker wait单次订阅容器退出；三种driver的长驻backend completion共用worker.controls.fail。backend-failure.json持久诊断及版本下限，重复失败幂等；迟到完成不清除中断，native/submit拒绝继续输入，显式恢复沿用身份。正常停止与普通PTY退出不误报。

- 2026-11-07修订调查：codex-gateway.ts在createCodexGateway阶段预先thread/start并绑定ID；nativeLaunch固定resume，pristineThread只覆盖resume/read/turns-list，真实items分页仍失败；R修订拟删除该绕行，不将本行当新设计已实现。
- 2026-11-07修订调查：terminal/command.ts原生入口先openDevelopmentSession落盘、派发worker再打开界面；sessions/runtime.ts及runtime-driver.ts以DevelopmentSession作为启动上下文，任务/审计依赖正式记录，D19需要分离启动资源关联。
- 2026-11-07能力补证：私有cold-lifecycle/result.json显示Codex0.162.1普通--remote真实PTY自行thread/start、thread/started返回ID、显示输入界面；无turn/start，正常退出。仅主机能力探针，不代表Docker产品验收。
- 2026-11-07修订调查：cli/session-commands.ts的session-resume只调用recoverSession，recovery.ts恢复任务并返回摘要，尚未验证新worker和原生历史实际就绪；D19/D20已确认，R提纲待确认。

- 2026-11-07：`src/sessions/operation.ts` 的准入强制解析正式session.json；启动期复用准入时需显式支持启动资源身份，不能单改入口延迟保存。R02前重核文件预算与调用迁移。
- 2026-11-07：`src/sessions/audit.ts` 使用任务terminalSessionId核对归属，证据按任务落盘；临时启动关联也必须保持此归属校验，不为延迟正式记录弱化审计。

- 2026-11-07：`src/agents/sessions/claude-driver.ts`只配置UserPromptSubmit/Stop；真实Claude 2.1.263原生!命令不触发拒绝UserPromptSubmit或PreToolUse钩子即可写测试marker，不能据普通提示准入证据宣称所有首次开发入口受控；证据见.local/evidence/direct-terminal/lifecycle-r01/。

- 2026-11-07：`src/sessions/json-command.ts`和`worker-api.ts`已有prompt提交/事件观察，首次身份仍提前announce；统一输入需扩展可校验请求/能力类型而非添加第二模型通道。
- 2026-11-07：`src/sessions/runtime-driver.ts`仍为Claude主动打开空闲PTY，为三Agent暴露native；D21后要先迁移结构化装配，再删除只服务原生入口的通道。
- 2026-11-07：`src/agents/sessions/codex-gateway.ts`当前442行，Claude/OpenCode驱动分别289/327行；统一输入提纲把协议提取、适配和旧路径清理分片，删除也计差异预算。

## U迁移过程（过渡字段已由后续清理移除）

- 2026-11-07 U02：sessions/requests.ts提供ExecutableSessionRequest（message/skill）与ReadonlySessionRequest（capabilities/skills）；capabilities.ts分别声明技能list/invoke的supported或带reason的unsupported；agents/sessions/contract.ts新增StructuredSessionRequests而不改变旧适配器要求。
- 2026-11-07 U03：startup-context.ts openStartupContext验证注册真实根/Agent/可信档案，不创建session/task/container或读密钥；startupId仅临时关联，资源句柄仅当前入口持有；capability-discovery.ts注入只读厂商供应方，缺供应方明确unsupported。旧openDevelopmentSession提前落盘行为暂保留至入口迁移。

- 2026-11-07 U01：scripts/structured-probe-support.ts提供隔离进程/假协议，probe-structured-sessions.ts实际验证三Agent结构化首建及同ID恢复；Codex skills/list与typed skill input实证；Claude/OC只有技能发现已证，invoke未证。私有证据unified-u01/result.json及中间失败保留，不等于真实模型验收。
- 2026-11-07 U04：sessions/activation.ts createSessionActivation按StartupContext复用；首请求与V2身份同目录暂存后rename发布，sessionId保存成功才可见；callback仅执行一次、失败保留、close按同步准入顺序决定清理。first-request accepted不是已执行，不扫描重放。
- 2026-11-07 U05：agents/sessions/codex-rpc.ts集中request/accept/close，网关保留事件串行与故障处理；旧native尚未删除。

- 2026-11-07 U06：createCodexDriver/Gateway structuredOnly=true不启动renderer/WS，不用pristine；read限定已有只读白名单且不能跨thread，submitInputs支持text/skill。纯模式nativeLaunch getter拒绝访问，装配不能展开整个driver对象。
- 2026-11-07 U07：createStructuredClaudeDriver只在submit启动非TTY print，先bindNative后执行，首次失败保持ID/resume；getInitialization只读缓存真实system/init，无prompt发现。旧factory与hook桥暂留。
- 2026-11-07 U08：OpenCode structuredOnly=true不启动proxy/attach，已有ID必须GET/session核对，readCapability仅skill/command；bridge检查finish/error，外层持租约，旧native保留。

- 2026-11-07 U09–U11：三厂商驱动统一capabilities()/listSkills()/execute；Codex从真实列表解析唯一可信路径后typed skill执行，Claude只投影已收到init.skills、OC只投影GET/skill，后二者调用明确unsupported，不prompt拼接。
- 2026-11-07 U10补证：真实Claude stream-json control_request initialize无prompt可对已有--resume返回success/idle，对缺历史result error且exit1；控制响应不回显原生ID，身份来自明确resume参数及缺历史拒绝。私有证据unified-u10，后续U10b实现共用就绪探查，不凭history文件或容器running宣称成功。

- 2026-11-07 U10b：agents/sessions/claude-readiness.ts checkClaudeReadiness经容器专属Node包装器发唯一initialize控制帧，严格success/idle并有界结束子进程组；纯Claude driver.ready不bind、不改history、不发prompt。U12须在审计启动后await ready再发布worker。

- 2026-11-07 U12：runtime-driver.ts仅装配三Agent纯结构化驱动，不初始化native通道；审计仍在runtime先启动，Claude.ready后worker控制socket才发布。worker WorkerSessionDriver新增可选execute(request,{emit,lease})/capabilities/listSkills，旧submit兼容，命令接入交U13。

- 2026-11-07 U13：commands.ts集中普通消息与/help/status/exit/stop/review/skills/skill/capabilities解析，拒绝未知和直接shell，技能参数尾空白保留；worker-api支持execute/只读能力，worker每请求先写私有requests/<uuid>.json再调用Agent，accepted不代表可重放。socket双方UTF-8解码避免中文跨块损坏。
- 2026-11-07 U17：readiness.ts ensureSessionReady复用真实派发等待并核对workerPid与原生/任务/环境身份；recoverSession先释放recoveryIntent再派发，失败保留中断，真正就绪后才idle/成功，不发送prompt；session-resume公开命令等待该流程。

- 2026-11-07 U14：runJsonSession支持activate(request,onSaved)/readOnly及兼容ensureSession；JSON支持request/command/旧prompt，relay.readonly可无正式ID，错误含phase。输出失败捕获后仍dispatch/execute已保存请求，再结束观察；/stop成功不再replay，/exit及EOF/Abort不发送stop。

- 2026-11-07 U15：terminal/line-{input,output,session}.ts复用runJsonSession，启动help无身份、多轮统一命令，真实delta/complete去重，退出仅离开观察，无rawmode/清屏。
- 2026-11-07 U18：Webcoding relay-runtime.ts通过同CLI stdin发送typed请求/命令；relay.readonly使用系统通知无助手历史，无ID不绑定，可靠身份冲突拒绝；phase保留。

- 2026-11-07 U15修订：LineSessionOptions.sessionId随初始help和后续payload传入共享控制层，恢复先验证/ready/announce，同ID只读状态不误作新启动。

- 2026-11-07 U16a/b：terminal/command.ts默认runLineSession；JSON携带已有ID时不读取新开发档案，新activate按需openStartupContext并原子保存。ensureSessionReady注入connectSessionWorker以复用已就绪后台；startup-close.ts只关闭当前登记句柄，accepted后不清理正式worker；实际CLI空查看无新正式记录。

- 2026-11-07 U19b/U20b/U21b：Codex gateway无WS/pristine/原生输入分支，Claude只留结构化factory（仍用专属进程包装器），OpenCode只留serve/request且恢复GET核ID。Codex过渡参数和Claude无引用桥由下一波c清理；原生聊天历史不动。

- 2026-11-07 U19c/U20c：Codex gateway只暴露真实结构化协议，runtime去废弃参数；运行时回归验证旧submit先保存再execute。Claude bridge及专属引用已删除。旧native前端/transport待U22按引用顺序收尾。

- 2026-11-07 U22a/b/c：删除terminal frontend/native-input、sessions native-channel/attach/transport与专属测试；worker保留native请求识别并固定拒绝，即便旧driver带native也0调用。Docker交互实现和独立TTY/nonTTY回归保留，旧V1历史不迁移。

## U22清理后的定位

- `src/terminal/command.ts`装配默认逐行或JSON入口；line-session只转换输入/显示，控制层共用json-command；不再含原生TUI入口。
- `src/sessions/startup-context.ts`只读授权配置；activation原子发布正式身份/首请求，startup-close仅关闭当前登记资源；worker保存每次请求再执行。
- `src/sessions/runtime-driver.ts`在审计之后装配纯结构化驱动；Codex为app-server RPC，Claude为stream-json/无prompt readiness，OpenCode为serve HTTP；均保留原生ID和历史。
- `src/sessions/worker.ts`固定拒绝旧native请求；frontend/native-input/native-channel/attach/transport及claude-bridge均已删除，不再作为扩展点。
- `src/sessions/readiness.ts`和recovery检查实际后台及同原生身份；正常入口先连接已有后台，不重复派发；故障需显式恢复，不重放请求。
- `src/sessions/review/`继续独立冻结审查；Webcoding relay-runtime只调用同CLI/外部ID，readonly作系统通知，未另建模型通道。

2026-11-07 维护修订：删除没有产品调用方的 capability-discovery.ts 和 StructuredSessionRequests，能力查询沿用结构化驱动。worker-api 统一查询、停止和审查等待策略；readiness 区分单轮错误与后端故障；Docker 监测在完整停止成功后关闭。当前边界见 devdocs/terminal-maintenance.md，以上 U02/U03 为历史实施记录。
