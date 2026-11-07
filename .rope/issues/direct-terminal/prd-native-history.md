> 历史归档：原生TUI要求已由D21替代；以下保留修订前PRD原文，不作为当前执行合同。当前合同见[PRD](prd.md)。

# 沙箱直接对话、统一会话与独立审查

状态：D21–D25统一输入方案已确认并选择完整流程；U切片提纲待确认，正文旧原生方案待下一步修订，不可直接实施。首轮合同已确认；2026-11-07 生命周期修订提纲已确认，本节新 Contract Note 已由用户确认，R01实测遇到Claude原生!命令准入缺口，后续实施暂停。原生直连、统一会话和独立审查已实现，两仓最终检查通过；真实入口最终delta发现Codex冷原生启动仍失败，已达两轮修复上限并升级；新版不发布。G1已授权但缺专用测试配置，真实模型调用0次；验收结论见e2e.md。

## Problem Statement

现有独立终端实际启动宿主 Codex 再委派沙箱开发，不符合用户直接与沙箱 Agent 对话的预期。网页沿用该协调链，旧会话 nativeId 指向宿主线程。现有执行器又以单轮收集结果为主，不能直接提供原生交互终端、共享原生上下文和断开后继续的统一行为。

## Solution

统一会话控制层保存外部 ID、原生 Agent 会话身份、环境及证据版本。独立终端提供原生界面，Webcoding 通过同一 CLI/会话层提供聊天界面；开发 Agent 在容器内执行。宿主程序控制生命周期和审计采集，明确 review 时才单独调用审查 AI。

优先扩展既有任务派发、持久环境、原子锁、审计、审核 Schema 和报告边界，不另造环境控制系统或网页模型接口。首次交付先验证原生跨模式能力，不以相同显示 ID 代替上下文连续性。

## Contract Note

- 首次打开终端即可进入所选沙箱 Agent 的原生界面；仅查看后退出不保存正式会话，并结束本次专用 Agent 进程，保留项目环境和必要日志。
- 首次有效开发请求先可靠保存正式会话身份与请求状态，再交给 Agent 执行；保存失败明确报错且不执行，已接受的请求不会因前端离开而被误杀。
- 正式会话在终端和网页间保持同一外部 ID、原生上下文和环境；恢复只有在真实 Agent 后台可用后才成功，失败保留原身份和可定位错误。
- 显式 review 继续独立审查代码和行为、保存结构化结论；后续开发重新待审，旧报告不覆盖新证据，审查凭据保持隔离。
- 兼容 Codex、Claude Code、OpenCode 及旧 CLI/MCP；不预建空线程强行恢复、不伪造历史、不自动重放，也不新增专用守护服务。

## Goals

- 容器内实际开发 Agent 直接接收消息；终端与网页共享会话，支持 Codex、Claude Code 和既有 OpenCode 选择。
- 实现多轮、恢复、断线继续、忙碌拒绝、独立审查及版本化证据的完整可观察流程。
- 每个状态和报告说明事实与缺口，避免正常开发成功被误报为安全审核通过。

## Non-goals

- 常驻宿主协调 AI、新专用 daemon/PM2 应用/系统服务、宿主崩溃后自动拉起或自动重放。
- 在不同 Agent 间自动迁移原生上下文，重写原生历史，按客户端绑定输入控制权，接管按钮或消息排队。
- 首版强制逐字增量，伪造流式，网页替换为终端模拟器，自动回滚 direct 原项目修改。
- 自动提交推送、读取真实用户项目做测试、复用生产会话做实验、删除持久环境或改造其他项目。

## Public Interface / Behavior

- `relay-sandbox`：启动/进入原生开发终端；保留 `relay` 别名。新启动先使用内部资源关联，首次开发准入后显示正式会话 ID；已有项目配置沿用，不猜测缺失的中转凭据。
- 恢复：沿用显式 `--session <session-id>` 能力；确切参数装配由 S17 固化，项目真实路径与权限须校验。
- `relay-sandbox review <session-id>`：用户显式请求独立审查；不存在、忙碌、配置缺失、结果无效分别明确错误，失败退出码非零。
- `relay-sandbox review <task-id> --file <path>`：继续提交既有结构化任务审核，不把旧调用静默解释成新会话审查。
- 结构化 CLI：保留 `chat --json --input-json` 的前端调用角色，改为直连开发会话；会话打开、发送、查询、读取事件、审查共用同一控制层。
- 公共事件至少包含协议版本、稳定 sessionId、单调游标、事件类型及时间；消息、工具、运行状态、审查状态分别表达。原生 ID 不得替代外部 ID。
- 开发输入走 stdin/受控本地传输，不把正文或密钥拼进 shell；原生终端字节不当作结构化审计事实。
- 审查固定代码和日志证据版本；已有关闭代码 AI 审核与其他检查配置继续生效。全部关闭时如实说明未执行，不伪造通过。
- 断开不启动后台收费审查，不终止已开始的一轮。明确停止可以停止本会话执行，保留可用现场，不误伤其他会话。
- 审查结束后可以继续原会话；新工作待审，旧版本补审只更新旧版本结果。
- Webcoding 以已有认证路径打开共享会话和触发审查；不因“不记客户端归属”取消鉴权和项目边界。
- 一个原生终端连接持续存在但等待输入，不等于开发执行忙碌；原始键盘输入也不能绕过操作互斥。
- 若原生 CLI 模式无法满足共享上下文或可靠执行状态，停止相应推进并报告事实，不能静默另建会话降级。

## Behavior Contract

- System under test：中转沙箱统一会话控制、原生终端、Webcoding 聊天及显式 review。
- Trigger/input：进入/恢复、发送多轮、前端断开、显式停止、共享 ID 打开、显式审查与补审。
- Collaborators：容器内开发 Agent、Docker、既有任务后台进程、采集器、原生历史、宿主独立审查 Agent；凭据与角色分开。
- Observable result：空启动无正式条目、首次准入先持久化、Agent真实恢复就绪、同上下文跨入口续接、本轮断线继续、共享进度、明确忙碌拒绝、证据绑定的独立审查报告及待审版本。
- Failure visibility：CLI 非零退出、网页明确错误和会话状态；缺失 ID、原生恢复失败、配置/鉴权/超时/输出非法、证据缺口分层说明。
- Forbidden shortcuts：宿主转述冒充直连；同显示 ID 绑定两套互不连续线程；复制历史冒充原生恢复；静默吞错；开发完成等于审查通过；拆字假流式；读取原生 TUI 文本猜测安全结论。

## Testing Decisions

- 测试公共行为和持久化事实，不断言任意内部函数拆分；每片新增行为先红后绿，错误路径必须可观察。
- 接口边界：会话存储/原子准入、开发适配器、Docker 交互、CLI 子进程、事件游标与重放、审查固定证据和输出校验、Webcoding 实际消息入口。
- 单元测试使用假传输/假模型证明状态、互斥、错误、版本绑定；不能证明真实 CLI 的原生恢复语义。
- 本机原生 CLI + 隔离假中转可验证启动协议、实际传输及上下文请求；真实远程模型语义另行进入 E2E，不混写证据等级。
- E2E 只列真实系统行为，见 e2e.md；不把逐片单元测试重跑冒充 E2E。
- 参考：`tests/unit/terminal*.test.ts`、既有任务锁/指标回归、`tests/integration/project-access.test.ts`；Webcoding `relay-runtime.test.ts`、原生 Codex 会话与进程停止测试。
- 完成时两个仓库各运行 lint、类型检查、测试、构建；新源码及测试少于 500 行。
- 不因重复本机查询引入 Redis；无新数据库/ENUM/CHECK 设计需求，使用现有文件存储、Schema 和原子操作模式。
- 新逻辑写入小模块。已有大文件仅做必要 import/委派装配，不继续堆业务逻辑；需扩大时先局部提取再重新切片。

## Architecture Impact

Impact：required。

触发：公开 CLI 和网页协议变化；执行依赖方向、会话持久化、原生生命周期、并发及错误语义变化；新增适配边界。需求对齐已经确认相应方向，剩余实际能力必须先证实。

### A1：终端/网页开发对话职责

- Source：`grill-decisions.md` D1、D7、D11–D17；`devdocs/terminal.md`。
- Decision status：active；原生直连已实现，验收状态见e2e.md。
- Scope：终端及 Webcoding 的开发对话。
- Decision disposition：supersede 旧终端协调器；inherit 外部 MCP 宿主委派模式。
- Inherited invariants：Agent 可配置、权限来自宿主配置、审查与开发职责分离。
- Affected public interfaces：终端入口、结构化 CLI、Webcoding runtime context。
- Forbidden shortcuts：只换文案仍调用宿主协调 AI；旧宿主线程冒充沙箱开发线程。
- Required evidence：E1–E3、E7；调用链与进程身份核对。
- Applies to：S01、S02、S09–S13、S17、S18、S22。
- Documentation update：recorded，devdocs/terminal.md、usage.md和Webcoding .devguide/relay-sandbox.md；验收状态单独记录。
- Unresolved conflicts：无产品决定冲突；原生模式可行性在 S01 先证实。

### A2：统一身份、事件与操作准入

- Source：`grill-decisions.md` D9、D14–D18；`src/terminal/session.ts`、既有任务锁。
- Decision status：active；旧版 metadata 的 nativeId 属于宿主，不可误迁移。
- Scope：外部 ID、原生 ID、项目/环境绑定、事件及并发。
- Decision disposition：extend 既有存储/互斥；supersede 客户端会话与宿主线程的旧关联方式。
- Inherited invariants：原子私有落盘、真实路径校验、原生历史保留。
- Affected public interfaces：会话 JSON、原生恢复、事件序列、忙碌错误。
- Forbidden shortcuts：共享显示 ID 却另开原生上下文；客户端身份锁；只检查 busy 而不原子准入。
- Required evidence：并发准入测试、原生续接、E1–E3/E5。
- Applies to：S01–S04、S09–S14、S18、S21。
- Documentation update：recorded，devdocs/terminal.md、structure.md及implementation-validation.md；网页契约见Webcoding .devguide/relay-sandbox.md，发布结果见本机记录。
- Unresolved conflicts：无；实际状态信号的能力证据在 S01 留档。

### A3：断开与后台执行

- Source：`grill-decisions.md` D5、D8、D10；`devdocs/persistent-environments.md`、`src/tasks/dispatch.ts`。
- Decision status：active。
- Scope：前端断开、任务进程、环境和采集。
- Decision disposition：extend 任务自身后台派发；inherit 持久环境、指标留证和显式删除规则。
- Inherited invariants：不自动删环境，不宣称强杀/宿主故障后完整恢复，不因退出自行收费审查。
- Affected public interfaces：断开、查询、停止、恢复状态。
- Forbidden shortcuts：新专用 daemon；退出前端即杀开发；重连自动重放副作用。
- Required evidence：E4、E7；重连结果与进程清理边界。
- Applies to：S06–S08、S12、S13、S21。
- Documentation update：recorded，devdocs/terminal.md、structure.md及implementation-validation.md；网页契约见Webcoding .devguide/relay-sandbox.md，发布结果见本机记录。
- Unresolved conflicts：无；容器退出仍按中断处理，不能等同于前端断开。

### A4：独立审查、证据版本及报告

- Source：`grill-decisions.md` D2–D6、D9、D13、D14；`devdocs/review.md`、`devdocs/user-reporting.md`。
- Decision status：active。
- Scope：显式审查、代码/行为结论、失败补审及报告。
- Decision disposition：extend 程序控制的独立审查；inherit 摘要校验、事实报告和风险分类。
- Inherited invariants：不以运行风险单独拒绝正确代码候选，不把报告落盘等同已向用户输出，不把无记录当安全。
- Affected public interfaces：review CLI、网页审查、报告及错误状态。
- Forbidden shortcuts：模型自报完成；跳过固定证据；旧报告覆盖新版本；失败吞掉并显示通过。
- Required evidence：E5、E6，关闭配置及失败场景测试。
- Applies to：S07、S14–S17、S19–S21。
- Documentation update：recorded，devdocs/terminal.md、structure.md及implementation-validation.md；网页契约见Webcoding .devguide/relay-sandbox.md，发布结果见本机记录。
- Unresolved conflicts：无；G1 已确认限定范围和次数。

### A5：访问、配置和旧接口兼容

- Source：`devdocs/project-access.md`、`devdocs/behavior-policy.md`、`devdocs/relay-setup.md`、`devdocs/decisions.md`；D3、D6、D7、D13、D17。
- Decision status：active。
- Scope：direct/isolated、持久环境、开发/宿主凭据、旧 CLI 和外部 MCP。
- Decision disposition：inherit，除已确认终端入口职责外不改变既有业务规则。
- Inherited invariants：direct 即时改原项目且不自动回滚；授权不可被模型扩展；非 Git 项目可运行；开发侧不持有宿主审查凭据。
- Affected public interfaces：配置读取、环境绑定、任务审核 --file、MCP。
- Forbidden shortcuts：自动重置环境、读生产用户项目验收、凭据混用、静默强制启用关闭的审核。
- Required evidence：E5、E7、既有交付与授权回归。
- Applies to：S02、S05、S07、S14–S19、S21、S22。
- Documentation update：recorded，devdocs/terminal.md、structure.md及implementation-validation.md；网页契约见Webcoding .devguide/relay-sandbox.md，发布结果见本机记录。
- Unresolved conflicts：无。

### A6：协作和持久文档

- Source：AGENTS.md、`.rope/routes.md`、`devdocs/writing.md`；Webcoding AGENTS.md。
- Decision status：active。
- Scope：共享工作目录、代码维护、检查、文档、发布与 Git。
- Decision disposition：inherit；skill 默认提交要求受用户“不自动提交推送”规则覆盖。
- Inherited invariants：保留已有未提交成果；中文注释和文档；不扩充大文件；构建检查后只发布目标服务。
- Affected public interfaces：无新增产品接口。
- Forbidden shortcuts：自动提交推送；覆盖工作区；跳过验收仍标完成；顺手修改其他 Agent。
- Required evidence：两仓检查、文件长度、差异审阅及 E8。
- Applies to：全部、S23a/S23b/S24、verify。
- Documentation update：recorded，devdocs/terminal.md、structure.md及implementation-validation.md；网页契约见Webcoding .devguide/relay-sandbox.md，发布结果见本机记录。
- Unresolved conflicts：无；按用户规则不提交不阻塞共享模式执行。

New decision candidate：无未获确认的产品架构候选。PTY/适配/本地 IPC 的具体实现由 S01 实证后选择；若需要新增依赖、扩大权限或无法满足已确认合同，停止并报告，不能静默变更。

## Constraint Bundle

Decision sources：`grill-decisions.md` D1–D18（用户确认），A1–A6 上述既有文档（active）；没有独立 Rope specs/ADR 时沿用 `.rope/routes.md` 的 devdocs 路由。

Scope：本 issue、两仓目标入口与共享会话层；下表映射每项约束到切片和真实证据。逐片仅传入全局约束和所属子集，不复制整份方案。

Public seams：CLI、共享会话记录/互斥、原生 Agent 适配、Docker 交互、事件存储、独立审查、Webcoding 已认证消息入口。

| ID | 来源 | 不变量与禁止捷径 | Applies to | Acceptance evidence |
| --- | --- | --- | --- | --- |
| C01 | D1、D7 | 终端与网页直接交互沙箱开发 Agent，既有 MCP 宿主委派保留。 | S05、S09–S13、S17–S20、S22 | E1、E2、E3、E7 |
| C02 | D9、D15、D17 | 稳定外部 ID 映射同一原生上下文、项目、环境与审查记录；不伪造跨模式恢复。 | S01、S02、S04、S09–S13、S18 | E1、E2、E3 |
| C03 | D14、D16 | 原子准入开发/审查，忙碌立即拒绝，无客户端控制权、不排队、不打断。 | S03、S06、S12–S14、S19、S21 | E2、E3、E5 |
| C04 | D11、D12 | 本机原生 TUI、网页结构化聊天；原生命令与终端屏幕不冒充控制协议。 | S01、S08–S13、S18、S20 | E1、E2、E3 |
| C05 | D5、D8、D10 | 普通断开后台本轮及采集继续，无专用 daemon；显式停止与离开分开。 | S06–S08、S12、S13、S21 | E4 |
| C06 | D2、D3、D6、D13 | 显式 review 才审查，遵从冻结配置，代码与运行行为分别给结论。 | S07、S14–S17、S19、S20 | E5 |
| C07 | D4、D5、D9 | 审查失败未完成，保留证据可补审；新工作待审，旧结论绑定旧版本。 | S14–S16、S20、S21 | E5、E6 |
| C08 | D3、D17 | 开发与审查配置独立，审查凭据不入沙箱；证据/输出脱敏，不执行不可信指令。 | S02、S05、S07、S15、S18、S19 | E5、E7 |
| C09 | D7、D13、D17 | 旧 review --file、外部 MCP、旧历史识别及其他网页 Agent 兼容。 | S02、S17、S18、S22 | E7 |
| C10 | D18 | 真实增量尽力及时展示；允许完整消息，不用拆字伪造流式。 | S01、S04、S09–S13、S18 | E1、E2、E3 |
| C11 | D3、D6、D7 | direct 即时影响、isolated 应用、持久环境和配置关闭保持既有语义；非 Git 项目仍可固定证据。 | S05、S07、S14–S16、S21 | E5、E7 |
| C12 | D1–D18、AGENTS | 中文注释，源码/测试少于500行，每片约400行/4文件；两仓检查、文档、构建及授权发布；不自动提交推送。 | 全部、S23a、S23b、S24 | E8、verify |
| C13 | D3、D6、D9、D14 | 审查固定证据与可写进程控制一致；原生界面等待输入不当作忙碌，但禁止绕过控制层提交新执行。 | S01、S03、S08、S12–S16、S21 | E1、E2、E4、E5 |

Open conflicts：没有待决的产品规则；G1 已确认由 AI 限定执行。S01 结果为实施可行性前置，不得略过。

## References

- 确认决定：grill-decisions.md D1–D18。
- 实现定位：map.md；切片顺序：slice-outline.md。
- 正式任务与矩阵：tasks.md；真实验收：e2e.md。
- 本机部署信息沿用忽略目录 `.local/devdocs/`，公开文件不写实际凭据或私有路径。

## Open Questions / Human Gates

- G1：已确认由 AI 使用既有专用配置限定执行；缺配置时如实记录 blocked，不扩大预算。
- Contract Note：首轮摘要已确认；2026-11-07修订后的五条摘要已由用户选择1确认。
- S01：原生 TUI 状态/输入控制、跨模式上下文与断线行为需实证；失败回到具体需求冲突，不擅自降低要求。

## Gate Decisions

### G0：本机隔离验证

- Decision：approved（既有开发授权内的可逆本地测试）。
- Approved action：在独立临时目录及带测试标识的 Docker 资源中运行真实 CLI、假中转和本地测试；只使用合成文件与假凭据。
- Scope：目标仓库及测试自有目录/容器，不操作用户项目任务或宿主凭据文件。
- Risk：local-write，可能启动测试进程和容器。
- Pass criteria：可清理测试资源，原项目与其他会话不受影响。
- Failure report：保留脱敏阶段、退出码、关联 ID 与缺口。
- Forbidden out-of-scope actions：新依赖/系统包、权限扩展、其他服务更改、删除既有环境。

### G1：真实模型与原生上下文验收

- Decision：approved（用户选择 1，由 AI 执行下面的限定动作）。
- Approved action：对 Codex、Claude Code、OpenCode 的现有专用测试配置，各执行最多两轮简短合成对话；独立审查最多两次，失败不自动反复调用。
- Scope：新建临时合成项目和测试会话，验证 CLI 原生上下文、跨入口续接、审查结果；不使用生产会话或用户代码，不读取/回显密钥。
- Risk：远程模型请求可能计费；Agent 一轮可能包含多个协议请求，轮数上限不等于请求数或金额上限。不承诺未经提供方计量即可精确封顶费用。
- Pass criteria：能证明实际原生上下文与审查结果；每个 Agent 单独记录结果，不沿用其他类型证据。
- Failure report：缺少专用凭据/可用模型时记录 blocked 或 user-run；鉴权/协议失败不猜测修复、不无限重试。
- Forbidden out-of-scope actions：新建付费账号、充值、借用他人凭据、收费重试循环、访问生产数据或任意放宽请求预算。

### G2：Webcoding 本机发布

- Decision：approved（用户 AGENTS 已明确要求完成后构建并重启网站）。
- Approved action：两仓检查构建通过后，更新现有 Webcoding 目标服务并重启，复用已有一次性续接机制验证 HTTP 和入口。
- Scope：本机既有 Webcoding 服务与中转沙箱构建入口，实际路径写入本机记录。
- Risk：production，本机网页连接短暂断开。
- Pass criteria：目标服务在线、HTTP 正常、新入口可用、发布配置只输出必要字段。
- Failure report：明确构建/启动/健康检查阶段，不因进程 online 就宣称功能验收通过。
- Forbidden out-of-scope actions：重启其他项目、自动部署远端、自动提交推送、改用户沙箱或生产会话作为探针。

## 执行与收尾

- 工作区：host-managed 共享模式；当前未提交变更属于此前交付与对齐成果，开始前记录基线，保留所有无关内容。
- 文件规模复核将 S23 文档收尾拆为 S23a/S23b，范围不变；共25片、17波次。依赖图只有一个相连交付链，按已确认顺序推进。
- 实施阶段可按 rope-go 使用叶执行者；最大就绪波次4片，当前4个总槽位包含父执行者，计划最多3个叶执行者并发，其余排队。只有已就绪且归属文件不重叠的片可同时执行。
- map、tasks 进度、review 和验证元数据由父执行者串行更新，避免共享文档冲突；若资源/事实要求进一步串行，记录具体原因。
- 不自动 commit/push，不为满足 skill 默认提交步骤而违背用户规则。包可保持未提交；无须把前序未提交成果重置到 HEAD。
- 全片完成后按 rope-go 做代码扫描和真实入口行为审阅，再 verify；真实验收未终态、阻塞未消除、文档未更新时不标 complete。

### G3：原生 Codex 协议代理依赖（实施调查新增）

- Decision：approved（2026-11-07 用户要求按架构方案实施）；已安装锁定版本。
- Approved action：增加运行依赖 `ws@8.22.1` 及开发类型 `@types/ws@8.18.2`，更新 package.json 与 pnpm-lock.yaml，供 S08/S09 的任务自有 WebSocket 代理复用。
- Evidence：capabilities.md；实际 native TUI 的 turn/start 可在 WebSocket 代理层返回 busy 且不请求模型；Unix socket 实际仍是 WebSocket 握手，不是 JSONL。
- Scope：现有 Node 项目依赖及任务进程；不增加常驻服务、系统包或新模型调用。
- Why gate：本计划明确要求新增依赖时停止并报告；原生协议已实证，现有依赖无成熟服务端实现，不能用手写帧解析替代。
- Acceptance：锁定依赖版本；代理准入、断开、异常与上限测试通过，再执行原生端到端验收；此调查不等于完整 S01/E1 通过。

## 2026-11-07 生命周期修订合同（优先于首轮冲突表述）

本节是D19/D20的正式展开。旧执行证据及S切片保持历史；当前执行范围见revision-tasks.md。首轮“启动即显示正式ID”和无条件“离开只断开”分别限缩为首次开发激活后、已接受开发或已有正式会话。

### 架构影响增量

Impact：required。触发身份持久化、首次准入、副作用顺序及公开恢复成功语义。

- A2：Source为grill-decisions.md D19、src/terminal/session.ts及src/sessions/operation.ts；status active，disposition extend；作用于R02–R13的身份/事件接口。保持正式ID与原生历史稳定，新增内部启动关联。禁止将临时关联冒充正式会话、先执行后落盘或双入口重复激活。证据为B16/B17、RE2及RE3。文档pending-finish；产品冲突无。
- A3：Source为D20、持久环境文档及后台派发实现；status active，disposition extend；作用于R08–R13的关闭/恢复接口。只关闭可证明专属且从未获准开发的进程，环境保留；已有正式会话与已接收工作继承断开继续。禁止不确定时盲杀、恢复重放或仅凭容器running报成功。证据为B15/B17/B18、RE1–RE3。文档pending-finish；产品冲突无。
- A1/A4/A5/A6：inherit，原生直连、独立审查、权限、host-managed和不自动提交均不变；作用于全部R片，证据沿用E1–E8并补RE1–RE4。文档pending-finish。
- New decision candidate：无产品候选；R01必须核对三个Agent的首次可执行请求及持久化信号。不能可靠拦截首次开发准入时停止相关片，不能从屏幕文本猜测或把正常打开算开发来绕过合同。

### Constraint Bundle 增量

Decision sources/status：D19/D20及用户确认的R提纲，active；继承C01–C13，C02/C05只按本节明确扩展。Public seams为启动上下文、正式存储、适配器首次准入、worker关闭、JSON身份事件、网页绑定及恢复就绪。Open conflicts：无产品冲突；能力事实R01待补证，不把未知当ready。

| ID | 不变量与禁止捷径 | Applies to | Acceptance evidence |
| --- | --- | --- | --- |
| C14 | 内部启动资源与正式会话分离；首次有效开发先持久化身份/请求再执行，保存失败不执行；菜单和未提交草稿不激活；必要审计不依赖正式记录存在 | R01–R13 | B14–B17、RE1/RE2 |
| C15 | 空启动离开仅收尾确认专属且从未获准开发的Agent；环境保留；已接受开发及已有正式会话断开继续，关闭与准入需原子裁决 | R06–R10、R13 | B15/B17、RE1/RE2 |
| C16 | 显式恢复等待真实后台可用，不仅启动容器或保存元数据；历史缺失明确非零，不换线程、不发预热请求 | R01/R04/R05/R12/R13 | B18、RE3 |

### 测试及人类门槛增量

- 每片先在首次准入/落盘、适配器信号、关闭竞争、就绪回执等公共边界写失败测试，再实现；断言文件、请求发送次数和退出/状态事实，不镜像内部函数。
- 首次请求包含工具/命令等可执行入口，不能只拦聊天文字；请求获准是生命周期边界，不等待模型成功回复。首次执行失败仍是正式会话。
- 并发用可控屏障覆盖保存失败、提交/离开双顺序及重复通知；不靠sleep概率碰撞。遗留会话/V1识别、direct/isolated及审查链需回归。
- 实际CLI/PTY与本地假接口可证明协议，不可替代真实模型上下文。E1–E8旧失败及缺口保留，RE轮按日期追加。
- G0/G1/G2及已批准G3继承，G1仍缺专用配置，不扩大额度；旧失败未解决或真实验收仍阻塞时不发布、不再次重启。
- Contract Note已确认；详细包不自动提交。确认后按11波次进入rope-go，R01失败则停依赖片，报告事实与合同差距。
