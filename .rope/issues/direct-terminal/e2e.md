# 终端直连：真实环境验收

当前统一输入验收见末节UE1–UE6，尚未执行；下列E/RE保留历史，不按原生显示要求阻塞新方向。历史状态：2026-11-07已执行真实构建CLI、测试自有Docker与本机假中转验收，最终修复delta已结束：E1/E4失败，其余blocked。真实远程模型验收缺专用测试配置。逐片单元测试证据写tasks.md，不冒充真实系统验收。

## 统一资源边界

- 仅新建合成项目、私有测试状态目录和测试标签 Docker 资源；真实用户项目、既有生产会话和其他容器不参与探针。
- 专用测试 Agent 配置由既有私有入口取得，不回显密钥、不把它们写进公开报告；审查配置不得进入开发容器。
- 假中转只能证明真实可执行程序在受控协议下的行为；不能声称已验证真实远程模型语义。
- G1 已确认由 AI 执行：每种 Agent 最多两轮简短真实模型开发对话，独立真实审查最多两次；不自动反复尝试。轮次上限不等于协议请求数量或精确金额上限。
- 用户选择自行执行时，相关项目标记 user-run，给出真实命令及合成场景，等待结果；未收到证据不得标 passed。
- 发生事实冲突、缺依赖或缺凭据时报告阶段、退出码、关联 ID 和脱敏日志路径；不擅自安装系统包、放宽权限或迁移生产配置。

## E1：真实原生终端与结构化协议能力

Architecture evidence：C02、C04、C10、C13。
Executor：agent。
Risk：local-write。
Gate Decision：not-required，沿用 G0 的隔离本机测试范围。
Approved Action：真实 CLI/容器与本机假中转交互，不请求远程模型。
Scope：Codex、Claude Code、OpenCode 的本机版本及测试自有目录、PTY、容器。
Command or Steps：

- 记录实际 CLI 版本、原生恢复参数、协议模式和可靠执行状态信号；保存来源，不只摘录 help。
- 通过实际 PTY 输入简短合成需求，检查原生菜单、颜色、光标、快捷键与窗口尺寸变化；原生命令不被中转沙箱无差别截获。
- 在假中转中使用可控延迟，观察实际执行开始/结束信号；等待输入不误判 busy，执行中不能从原始输入绕过准入并提交第二轮。
- 以原生 ID 在另一模式恢复，检查真实 CLI 发给假中转的上下文包含之前的合成消息；网页历史不得由另一套独立对话假冒。
- 有真实增量就验证及时转发；没有增量记实际限制，不用打字动画代替。

Pass Criteria：各 Agent 单独给出身份/状态/传输证据，强制合同无未解决冲突；流式限制可记录为非阻塞。
Failure Report：最小复现、版本和影响的确认决定；若强制能力不成立，停止依赖片并回到具体问题对齐。
Forbidden Out-of-Scope Actions：收费模型调用、全局 Agent 配置改写、假造上下文、从 TUI 文本关键词猜 busy。
Result：failed（2026-11-07）。实际三Agent本机CLI与测试自有Docker/假中转已有跨模式上下文证据，但Codex全新空会话TUI最终仍exit1：`failed to load a bounded thread item page`，未发prompt。NATIVE-E2E-002两轮修复后仍失败，已Human Escalation Stop；不以已有预热会话通过代替。TTY真实delta通过。证据：私有final/delta-native-result.json、delta-screen.txt、delta-tty-result.json；最终文件清单以reviewer记录为准。

## E2：Codex 真实模型跨入口会话

Architecture evidence：C01、C02、C03、C04、C10。
Executor：agent-with-gate。
Risk：remote-write（计费 API 请求）。
Gate Decision：approved，用户选择1，同意G1限定调用。
Approved Action：已授予；执行新建合成会话最多两轮，禁止生产上下文。
Scope：测试容器 Codex、统一 CLI、Webcoding 测试入口、专用测试模型配置。
Command or Steps：

- 从已构建 CLI 进入原生终端，发送仅含随机合成记号的简短要求，记录外部及原生会话 ID。
- 在网页通过同一外部 ID 打开，先观察已有状态，再发送第二轮要求模型引用第一轮记号并回复；核对请求仍在容器内同一 Agent 原生上下文。
- 回到原生终端恢复，检查网页产生的第二轮消息已经存在，不为展示另起模型对话。
- 执行中从另一入口发消息，观察立即忙碌拒绝，不多发模型调用，不要求接管。

Pass Criteria：实际模型能使用前文，底层原生身份不分裂，终端/网页双向看到共享历史；模型请求不经宿主开发协调器。
Failure Report：脱敏 native/session ID 关联、入口调用链、原始事件类型、失败阶段；不输出凭据或真实用户历史。
Forbidden Out-of-Scope Actions：多轮无界重试、使用当前工作项目生产模型会话、隐式新开上下文。
Result：blocked（2026-11-07）。已授权额度保留，但未取得专用测试配置；不使用生产项目档案。实际调用0次。三Agent真实CLI与假中转证据不替代此项真实模型验收。

## E3：Claude Code 与 OpenCode 真实模型跨入口会话

Architecture evidence：C01、C02、C03、C04、C10。
Executor：agent-with-gate。
Risk：remote-write。
Gate Decision：approved，用户选择1，同意G1限定调用。
Approved Action：已授予；对每种 Agent 各最多两轮合成对话。
Scope：两种 Agent 分别独立的测试会话、环境及专用配置，预算不因拆分此项而翻倍。
Command or Steps：

- 对每种 Agent 分别执行 E2 的原生→网页续接，并恢复原生界面观察网页回复。
- 分别核对原生 ID 映射、真实 CLI 路径、消息/工具/结束信号；不能沿用 Codex 的通过记录。
- 支持实际文本增量则及时显示；不支持时完整消息正常显示，明确能力范围。

Pass Criteria：两种 Agent 各自满足统一上下文与状态准入；流式是尽力项，不能以此豁免会话连续性。
Failure Report：每种工具独立结果；缺少可用模型或协议不兼容时 blocked，不静默删去已支持的 Agent 类型。
Forbidden Out-of-Scope Actions：跨 Agent 转录历史冒充原生恢复、新购服务、增加收费重试预算。
Result：blocked（2026-11-07）。Claude Code和OpenCode均缺专用测试配置，真实模型调用各0次；实际CLI跨模式上下文证据单列E1，不替代远程模型语义验收。

## E4：关闭前端后的真实进程存活及中断

Architecture evidence：C03、C05、C07、C13。
Executor：agent。
Risk：local-write。
Gate Decision：not-required，G0。
Approved Action：在测试自有 Agent、容器和假中转延迟场景中断开/重连或终止测试进程。
Scope：测试自有会话，不停止任何其他会话或容器。
Command or Steps：

- 让真实容器 Agent 执行受控慢任务，分别关闭本机终端连接和网页连接。
- 检查进程及采集继续，重新打开同 ID 后看到进度及最终结果，无重新派发副作用。
- 本轮完成后等待输入，不自动触发审查，不启动专用常驻 daemon/系统服务。
- 显式停止测试会话，确认只停止该会话；另一次强制结束测试 Agent/容器，重连明确中断和待审，不声称日志完整或自动恢复。

Pass Criteria：离开、停止、意外终止三种状态可区分；日志可追溯且有缺口说明；无遗留测试资源或误杀。
Failure Report：测试进程、状态转换、采集时间范围、退出及停止证据，不把137直接断言为OOM。
Forbidden Out-of-Scope Actions：结束宿主服务或生产容器、为了断线续跑新增常驻守护程序。
Result：failed（2026-11-07，部分路径通过）。真实CLI断开前端后worker及当前轮次继续、显式停止已有首轮证据。最终137注入后interrupted、证据版本递增、gap/failed及native拒绝通过，OOMKilled=false；公开stop/resume均exit0且同UUID、不重放，但恢复worker因冷Codex `no rollout found` exit1，未就绪，最终stop因socket不存在exit1。完整恢复不标通过，关联NATIVE-E2E-002，两轮后升级。

## E5：真实独立审查与风险展示

Architecture evidence：C03、C06、C07、C08、C11、C13。
Executor：agent-with-gate。
Risk：remote-write。
Gate Decision：approved，用户选择1，同意G1限定调用。
Approved Action：已授予；执行最多两次独立真实审查，输入仅为合成代码和证据。
Scope：合成项目已固定的候选/日志、独立宿主审查配置；运行期线索只用假密钥和本机接收器。
Command or Steps：

- 在正常代码和包含合成风险证据的两个固定版本上，分别从 CLI/网页显式发起审查。
- 核对代码与行为结论、证据摘要、报告 ID 和实际展示内容，审查配置不进入开发容器。
- 会话 busy 时执行 review，确认立即非零错误、开发不停止且不产生审查模型请求；证据固定时再发开发也不得同时准入。
- 在非 Git 项目及已有关闭代码审核配置下检查证据和结果说明；关闭项不能被强行重新执行。
- direct 模式报告说明修改已即时影响原项目，不能假报未改或自动回滚；isolated 沿用既有应用检查。

Pass Criteria：有真实独立审查结果，Schema 与证据绑定有效，风险和缺口分别说明，实际用户输出不靠文件存在推断。
Failure Report：模型/输出校验/证据/展示的具体阶段、脱敏状态与报告版本；不把拒绝或失败写通过。
Forbidden Out-of-Scope Actions：真实敏感文件或密钥诱饵、外传生产数据、开发Agent自行写入通过回执。
Result：blocked（2026-11-07）。缺独立宿主审查的专用测试配置，真实审查调用0次。已有本机假接口的暂停、失败补审与凭据隔离证据见E6，不代表真实模型风险判定已通过。

## E6：真实 CLI 的审查故障、补审与报告失效

Architecture evidence：C06、C07。
Executor：agent。
Risk：local-write。
Gate Decision：not-required，G0。
Approved Action：真实 CLI 和实际文件存储连接受控本机审查接口，注入超时/401/非法输出。
Scope：新建会话和假凭据，不请求远程模型。
Command or Steps：

- 分别注入超时、鉴权失败及非法结构化结果，观察 CLI/网页未完成状态，退出后成果和证据仍存在。
- 对原固定证据补审，不再次启动开发；继续开发后用旧证据补审，不能把当前新工作改成已审查。
- 重连读取旧报告和新待审状态，核对版本绑定而非仅使用更新时间判断新旧。

Pass Criteria：失败原因可定位、不吞堆栈，补审和开发版本边界正确；无旧报告覆盖新状态。
Failure Report：退出码、错误阶段、固定摘要和状态变化，异常链完整脱敏。
Forbidden Out-of-Scope Actions：删除证据掩盖错误、修改生产审核配置或伪造通过。
Result：blocked（2026-11-07，部分故障路径通过）。真实CLI的非法JSON、401、timeout和固定证据补审均incomplete/exit1、保留pending；401最终delta保留实际错误原因及堆栈。尚未真实完成有效审查→新开发→旧报告补审的完整版本失效链，不能以单元回归代替。证据：final/review-results.json、delta-review-results.json及acceptance-report.md。

## E7：真实旧入口、访问与凭据隔离兼容

Architecture evidence：C01、C08、C09、C11。
Executor：agent。
Risk：local-write。
Gate Decision：not-required，G0。
Approved Action：隔离 home 下启动实际 CLI/stdio MCP，使用测试项目和假模型服务检查既有入口。
Scope：测试记录及容器；已有真实用户项目只保留，不读取内容。
Command or Steps：

- 使用旧 review task --file 入口提交实际合成审核，核对仍走 task 语义；新 review session 走独立审查，非法对象明确拒绝。
- 对 version=1 的旧宿主终端记录请求恢复，必须明确识别并保留原历史，不把其 nativeId 传给沙箱开发 Agent。
- 走实际 MCP 的配置发现、任务创建/派发/检查/上报链，确认外部宿主委派能力保留。
- 分别运行 direct/isolated、持久环境复用和非 Git 项目，确认既有权限及生命周期约定。
- 用假凭据哨兵检查沙箱环境、消息、工具日志和输出，不出现宿主审查凭据；网页经既有认证授权路径操作，错误ID不跨项目。

Pass Criteria：旧入口可用、无身份错配或凭据泄漏；其他网页 Agent 的协议和配置未受无关变更。
Failure Report：实际入口、对象类型、冻结配置摘要和边界证据；不输出全量环境。
Forbidden Out-of-Scope Actions：用户项目配置批量迁移、删除旧历史、绕过网页鉴权。
Result：blocked（2026-11-07，部分兼容路径通过）。旧V1拒绝且历史保留、旧review --file exit0→ready、实际stdio MCP start_task准备/cleanup/report_task通过；direct、持久环境、非Git及审查密钥隔离已有真实合成证据。isolated新会话和其他网页Agent全业务尚未全测。证据：final/delta-legacy-results.json、old-review-result.json、mcp-results.json、mcp-report.json及acceptance-report.md。

## E8：本机网页发布与重启后验证

Architecture evidence：C12，发布后 C01/C02/C06 的可用入口。
Executor：agent-with-gate。
Risk：production。
Gate Decision：approved，沿用用户 AGENTS 的构建重启要求，范围见 G2。
Approved Action：完成检查后构建两仓并重启现有 Webcoding 目标服务；若当前会话托管于此，先登记既有一次性续接。
Scope：本机既有目标服务；路径和进程名只保存在 `.local/devdocs/`。
Command or Steps：

- 核对两仓最终检查和构建证据，再使用既有发布入口更新目标服务。
- 发布后检查 HTTP、实际构建前端的会话/审查入口和必要启动配置，仅输出必要字段。
- 用单独合成会话从实际网页打开共享ID，观察历史、忙碌提示及报告入口；真实远程对话仅在 G1 允许且预算内进行。
- 写本机发布记录和确认结果，不重复重启；不以online和静态文件200代替功能证据。

Pass Criteria：目标服务健康、入口与构建一致、计划续接成功、合成会话操作证据完整；其他服务未动。
Failure Report：构建/启动/HTTP/功能阶段独立说明，保留脱敏发布日志。
Forbidden Out-of-Scope Actions：新部署远端、重启其他项目、提交推送、泄露环境、修改用户项目任务。
Result：blocked（2026-11-07）。两仓最终检查构建通过，但E1冷原生入口仍失败，E2/E3/E5缺专用测试配置；本轮未登记重启、未重启Webcoding。此前旧版online和静态200不能作为新版发布证据。

## 结果记录规则

每项执行后追加日期、具体入口、资源范围、证据路径、实际结果和遗留缺口。passed/failed/blocked/user-run/skipped须与事实一致；未跑真实模型不能以本地假接口通过覆盖。用户明确豁免时才记录not-run-waived，并写豁免范围，不把它改称通过。

## 2026-11-07 最终收尾

Reviewer：`/root/native_final_acceptance`，实际裁定changes_requested，发布blocked。Scanner：`/root/native_final_scan`，最终静态delta passed。NATIVE-E2E-002累计两轮后仍失败，升级而非追加补丁。详细B01–B13事实矩阵及受控证据清单在忽略目录 `.local/evidence/direct-terminal/final/acceptance-report.md`。共18个唯一task/environment归属清理后，自有容器0、网络0、测试进程已退出；见final-cleanup-verification.json。收费模型调用0，未重启或提交。

## 生命周期修订轮（2026-11-07，尚未执行）

旧E1–E8结果保持；新证据必须关联旧失败和对应行为，不能用新编号掩盖缺口。RE项通过也不自动解除E2/E3/E5的真实模型配置阻塞。

### RE1：真实冷入口与空退出

- Architecture evidence：B14/B15、C14/C15，三个Agent分别记录。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0。
- Approved Action / Scope：实际构建CLI、PTY、测试自有Docker及本机假中转，合成非Git项目/私有home，假凭据；不访问用户项目。
- Steps：全新环境普通进入原生界面，记录请求方法和真实原生ID；仅查看菜单/草稿后退出；检查正式列表、专用进程、持久环境、必要审计。再进入确认环境软件保留且没有假历史暖启动。
- Pass Criteria：真实输入就绪；正式记录0；专用进程已结束，环境保留；没有turn/开发请求或远程模型调用。不得把旧预热会话当冷启动。
- Failure Report：CLI版本、入口、脱敏协议阶段、退出码、资源归属和证据路径；不输出完整环境。
- Forbidden Out-of-Scope Actions：真实密钥、生产容器、系统安装、新服务/依赖。
- Result：pending。此前host侧正常remote探针只证明原生创建能力，不是本项通过。

### RE2：实际首次请求与断开边界

- Architecture evidence：B16/B17、C03/C14/C15。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0。
- Approved Action / Scope：实际终端及JSON入口连接受控本机接口，测试自有状态和容器。
- Steps：首提交观测正式记录和请求发送顺序；存储失败时确认模型/执行请求0次；首执行失败仍读到正式记录；分别先提交后断开、先关闭后提交、重复通知及双入口竞争。覆盖实际支持的原生命令/工具入口。
- Pass Criteria：正式身份只激活一次、已接收工作继续、关闭胜出不执行；状态/错误与实际路径一致，无误杀、重放、虚假ID或未审查变已通过。
- Failure Report：脱敏时序、请求计数、文件状态、进程归属及退出码；可控竞态证据不能仅靠碰巧未复现。
- Forbidden Out-of-Scope Actions：生产目录写失败注入、真实模型重复收费试错、改权限策略。
- Result：pending。真实模型语义另见G1/E2/E3。

### RE3：实际中断与恢复就绪

- Architecture evidence：B18/B08、C02/C07/C16。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0。
- Approved Action / Scope：实际CLI及测试自有Docker/原生历史，受控本机接口；只终止确认属于测试的进程。
- Steps：合成请求建立真实原生历史，停止测试容器/Agent，再执行公开恢复命令；分别验证成功、原生历史缺失、初始化失败和超时；续接时核对同一外部/原生ID及历史。
- Pass Criteria：实际Agent可用才exit0；失败非零、错误含阶段且证据保留；无隐式prompt、自动重放、静默新线程；恢复后原生/JSON实际可用。137只描述停止事实，不无证据推断OOM。
- Failure Report：容器/worker/Agent三层状态、退出码、脱敏错误链、身份核对和证据路径。
- Forbidden Out-of-Scope Actions：操作用户项目容器、删除真实历史、复用生产凭据或自动改软件依赖。
- Result：pending。必须回归旧NATIVE-E2E-002冷恢复失败，不能只看metadata或running。

### RE4：网页与终端实际共享及发布

- Architecture evidence：B02/B10/B15–B18、C01/C09/C14–C16。
- Executor：agent-with-gate；Risk：production（仅发布阶段）；Gate Decision：approved，沿用G0/G1/G2，不扩大范围。
- Approved Action / Scope：隔离合成会话走实际Webcoding认证入口，先验证候选构建；真实模型仅在原G1配置和预算可用时。全部门槛满足才按既有G2发布目标服务。
- Steps：空页面不建relay正式记录；首提交后绑定正式ID，终端以同ID读取原生历史；已有会话只查看退出不杀后台；故障恢复在网页如实显示；核对鉴权/跨项目拒绝及其他Agent兼容；最终按E8完成一次性重启续接和HTTP/图标/功能验证。
- Pass Criteria：两入口同一上下文、状态和审查版本；无第二模型通道；冷入口/恢复失败已修复，旧必须验收缺口已解决或用户明确豁免，发布构建与入口一致。
- Failure Report：区分候选入口、远程模型、发布健康及功能证据；缺配置记blocked，不能以静态HTTP200冒充产品通过。
- Forbidden Out-of-Scope Actions：重复重启、其他项目服务、完整PM2环境输出、自动提交推送。
- Result：blocked，旧最终失败及G1配置缺口仍在；本轮尚未执行。

### 修订轮R01前置阻塞

2026-11-07：真实Claude 2.1.263原生!命令在UserPromptSubmit拒绝和PreToolUse拒绝两次探针中都写入合成marker，相关钩子调用0；仅调用本机假接口，无远程模型。此事实是准入能力失败，不是RE1–RE4产品验收通过；后续实施暂停，不修改旧E项结论。证据在.local/evidence/direct-terminal/lifecycle-r01/，可复现入口见scripts/probe-native-lifecycle.ts。

## 统一输入真实验收：UE轮（尚未执行）

当前目标按D21–D25，不再要求完整原生TUI。旧E/RE失败保留事实；只有旧原生显示要求被明确替代，身份/恢复/审查/真实模型缺口仍须对应验证。票级测试不列入以下真实系统验收。

### UE1：真实逐行入口与首次保存

- Architecture evidence：B15/B16/B19/B23，C04/C14/C15/C17。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0。
- Approved Action / Scope：实际构建CLI、真实Agent和测试自有Docker，隔离合成项目/状态目录，假凭据及回环假接口。
- Steps：默认relay进入逐行输入；仅帮助/技能列表/未提交草稿退出；再重新进入并提交有效消息；分别注入首次存储失败及Agent执行失败；观察真实调用、正式记录、进程归属与环境。
- Pass Criteria：自有界面可多轮，空查看不建正式记录，专属临时资源退出、环境保留；保存失败执行0次，执行失败记录保留；真实进度/错误无屏幕猜测；未知命令不执行shell。
- Failure Report：实际版本/入口、退出码、脱敏时序、请求计数、文件/进程归属，必要日志可定位。
- Forbidden Out-of-Scope Actions：用户项目/凭据/容器、原生TUI fallback、真实远程模型或新依赖/权限。
- Result：passed（G0）。三Agent实际逐行首次保存/执行与空查看通过；首次存储失败phase=save且零任务，首次401执行失败保留正式身份和accepted请求。回环假接口不证明远程模型业务语义。证据：私有unified-final/acceptance-report.md、save-failure-results.json及补测记录。

### UE2：真实终端与网页共享上下文

- Architecture evidence：B02/B10/B11/B19，C01/C02/C09/C10/C17。
- Executor：agent-with-gate；Risk：remote-write（模型请求）及local-write；Gate Decision：G0/G1 approved，专用配置缺失部分blocked。
- Approved Action / Scope：实际CLI和已认证Webcoding测试入口，新合成会话；模型部分仅既有G1额度/专用测试配置，各Agent分别记账，不重置次数。
- Steps：终端首次有效消息建立原生上下文，网页用同ID继续，核对事件/工具进度及历史；反向续接，检查项目鉴权及其他Agent不受改动。
- Pass Criteria：实际原生上下文连续，不仅显示ID相同；不启动宿主AI或网页另一个模型会话；增量如实展示，不支持则完整消息。回环假接口可验证协议，但不能替代本项真实模型上下文结论。
- Failure Report：分Agent记录入口/原生ID关联、脱敏上下文证据、鉴权边界、实际使用轮数和未覆盖部分。
- Forbidden Out-of-Scope Actions：生产历史、借生产凭据、额外收费重试、扩大G1预算、修改其他Agent配置。
- Result：blocked（G1专用配置缺失）。本机合成接口下三Agent均已实际完成终端首轮→已认证网页发送done→终端续聊，同外部/原生身份；未登录及非法ID拒绝。远程真实模型调用0，不能将协议连续等同真实模型语义验收。证据：私有unified-final/acceptance-report.md及网页补测记录。

### UE3：实际断线、竞态和恢复就绪

- Architecture evidence：B03/B04/B13/B17/B18，C02/C03/C05/C13/C15/C16。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0。
- Approved Action / Scope：实际CLI/JSON及测试自有Docker、原生历史、回环假接口，只停止归属明确的测试进程。
- Steps：提交后前端断开，观察后台开发/审计继续；另入口忙时提交立即拒绝；首提交与退出双顺序实际贯通；中断测试Agent/容器后公开恢复，另测历史缺失/初始化失败/超时。
- Pass Criteria：已接受请求不误杀、不重放、不排队；恢复成功后实际结构化接口可用且同原生ID；容器running但Agent失败非零，错误阶段清楚，恢复探活不发prompt。137不无证据推断OOM。
- Failure Report：容器、worker、Agent三层状态与退出码、脱敏时序、请求次数、原生历史关联及证据缺口。
- Forbidden Out-of-Scope Actions：中断生产容器、删除真实历史、为恢复隐式创建新线程、发收费暖启动。
- Result：passed（已执行G0场景）。EOF断线后台继续、忙时立即拒绝、三Agent正常停止后同ID就绪恢复通过；另实测Codex测试容器KILL后恢复同原生ID，删除仅测试原生历史后恢复exit1、身份不变、请求数不增。未逐Agent重复同类故障，未单独注入初始化黑洞超时；首提交竞态以屏障测试补充实际EOF双阶段证据，不冒称全部排列实测。证据：私有unified-final/disconnect-results.json、各Agent recovery结果及补测记录。

### UE4：实际原生技能能力与命令

- Architecture evidence：B15/B16/B20/B23，C03/C14/C17/C18。
- Executor：agent；Risk：local-write；Gate Decision：approved，G0；若需远程模型才可证明调用语义，转G1限定执行并单独记blocked/证据等级。
- Approved Action / Scope：三个Agent各自真实CLI/服务、临时合成技能及回环假接口，私有隔离配置；不是读取用户技能/历史。
- Steps：由统一入口发现技能，核对所选Agent原生来源；调用受支持技能并检查结构化原生能力；对不支持和不存在技能、未知命令分别观察终端/网页提示；只读退出核对无正式记录。
- Pass Criteria：支持分Agent明确，调用是真实原生机制且先保存准入；未支持清楚提示、不执行；不拼提示词冒充、不另建技能安装系统、不启用直接shell。上下文压缩缺失不阻塞首版。
- Failure Report：版本、能力来源、原生请求类型、调用计数、失败阶段及假接口不能证明的远程语义边界。
- Forbidden Out-of-Scope Actions：安装第三方技能、读取私有技能、扩展模型预算或执行未经审阅的外部技能。
- Result：passed（G0协议范围）。实际原生能力列表与Codex合成技能typed调用通过；Claude/OpenCode独立调用明确unsupported且不伪装执行，未知技能拒绝，空查看无正式记录。未读私有技能、未调用远程模型，不等于模型语义验收。证据：私有unified-final/acceptance-report.md、acceptance-results.json和recovery-results.json。

### UE5：独立审查与兼容完整链

- Architecture evidence：B05–B10/B12/B13，C06–C09/C11/C13。
- Executor：agent-with-gate；Risk：local-write及remote-write（仅真实审查）；Gate Decision：G0/G1 approved，缺专用配置部分blocked。
- Approved Action / Scope：隔离合成会话和假审查故障接口，真实审查沿既有G1最多两次额度；实际旧CLI/stdio MCP、direct/isolated/无Git测试自有环境。
- Steps：显式审查、忙碌拒绝、配置关闭、401/超时/非法输出、有效审查后新开发再补旧版本；检查原生技能执行同样使旧证据待审；旧review --file、V1拒绝/历史保留、MCP委派及网页鉴权/其他Agent回归。
- Pass Criteria：结构化报告与固定版本一致，旧报告不覆盖新开发，失败可追溯可补审，宿主审查凭据不入沙箱；旧入口及访问/持久化语义保持。真实审查缺配置不能用假接口代替通过。
- Failure Report：脱敏固定摘要、版本转换、实际报告/输出回执、错误阶段和兼容缺口，不输出完整环境/密钥。
- Forbidden Out-of-Scope Actions：用户项目、放宽权限、收费循环、删除失败证据、自动回滚direct修改。
- Result：blocked（G1真实独立审查配置缺失）。缺配置明确incomplete；慢检查关闭AI完成报告；旧review --file、V1拒绝保留历史及真实stdio MCP通过。补测无Git isolated有效假审查→新开发→旧固定补审，旧报告不覆盖新版本且宿主未交付文件；401/非法/超时证据明确复用旧实际记录，不称本轮全部重跑。证据：私有unified-final/acceptance-report.md及补测记录。真实模型调用0。

### UE6：最终发布与一次性重启续接

- Architecture evidence：C12及已通过的UE行为；适用于U26/verify。
- Executor：agent-with-gate；Risk：production；Gate Decision：approved，既有G2，前置当前仍blocked。
- Approved Action / Scope：两仓检查构建和必须真实验收通过后，发布既有Webcoding目标服务，不部署新服务/远端。
- Steps：核对最终代码扫描及真实行为审核；必要时登记既有一次性续接，再执行单次目标服务重启；核对HTTP、图标、构建输入入口、合成会话/技能及review路径和必要启动字段。
- Pass Criteria：构建与运行版本一致、目标健康、功能与文档一致，旧失败保留、新验收逐项有证据；只有online或HTTP200不算功能通过。
- Failure Report：构建/重启/HTTP/功能分阶段记录；只展示必要配置字段，不打印完整PM2环境。
- Forbidden Out-of-Scope Actions：未验收即重启、重复续接重启、改其他服务、自动提交推送或使用用户容器测试。
- Result：blocked。U01–U25及三项终审修复已实施；主仓lint/check/test/build通过（388通过57配置跳过），Webcoding全链通过（794通过）。代码静态增量及实际修复复验approve，产品验收仍有上述阻塞，G1缺专用配置，未满足发布前置，不重启。实际自有资源最终清理见私有unified-final/resource-verification.json与process-verification.json。
