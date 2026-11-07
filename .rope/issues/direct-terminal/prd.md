# 统一逐行终端、共享会话与独立审查

状态：D21–D25需求及U01–U26提纲已确认；当前五条交付摘要已由用户选择1确认。U01–U25完成，U26检查与代码双审通过，G0实际验收范围见e2e.md；真实模型专用配置缺失，U26及发布blocked。旧原生PRD在prd-native-history.md，旧实际失败在review.md/e2e.md，不能将计划写成已实现。

## Problem Statement

原生TUI不能仅依赖现有hook/proxy证明所有操作都经过共享准入。实际Claude原生!命令绕过拒绝钩子，破坏“首次执行先保存”的保证。Codex冷原生renderer及恢复也存在已记录失败。用户现已选择自有逐行输入，保留原生上下文而不透传原生界面。

## Solution

终端与Webcoding共用请求、身份、能力、事件和审查控制层。宿主程序先验证及可靠保存请求，再通过容器内所选Agent的结构化接口执行；没有常驻宿主AI转述。各Agent保留自己的原生会话，外部统一ID不替代原生ID。

复用已有JSONL、worker、原子文件/租约、持久环境、审计、结构化审核及Webcoding鉴权。先补证真实结构化创建/恢复及技能能力，再扩展接口、迁移调用，最后删除仅服务原生TUI的通道；不重写历史。

## Contract Note

- 运行relay或relay-sandbox进入自有逐行对话，终端与网页通过同一控制层连接所选沙箱Agent，展示真实回复、工具进度及状态，不再完整透传各Agent的原生TUI。
- 仅打开、查看帮助或技能列表不保存正式会话；有效开发请求先保存身份和请求状态再执行，保存失败不执行，已接受工作断线后继续，项目环境和必要日志保留。
- 正式会话跨终端和网页保持同一外部ID、原生上下文及环境；恢复须等Agent真正可用，失败明确报错，不自动重放或静默另开线程。
- 统一提供帮助、状态、退出、停止、审查及技能入口，技能来自当前Agent；不支持时清楚提示，不直接执行输入中的shell命令，不建立独立技能管理系统。
- 显式审查继续分别审查代码和行为、保存结构化结论并隔离凭据，新开发重新待审；Codex、Claude Code、OpenCode及旧CLI/MCP的适用行为分别验证，不以假接口通过冒充真实模型验收。

## Goals / Non-goals

目标：逐行多轮、先保存后执行、共享原生上下文、空查看无正式记录、断开继续、真实恢复、明确忙碌拒绝、技能能力发现及显式独立审查。

非目标：完整TUI/终端模拟器、任意Agent专属命令/直接shell、统一技能安装管理、跨Agent历史转换、宿主协调AI、新专用daemon、自动重放、自动提交推送、自动回滚direct修改、首版强制上下文压缩或逐字增量。

## Public Interface / Behavior

- relay-sandbox默认进入逐行输入，relay为别名；已有--cwd/--session沿用可信项目校验，旧宿主V1记录明确拒绝误恢复并保留历史。
- 消息、技能执行和只读能力分别校验；命令由统一路由识别。具体命令名在实现中集中定义并由帮助展示，不使用屏幕文本猜测语义。未知命令明确提示，不直接交shell，也不猜测转为开发需求。
- 帮助、状态及技能发现是只读，不创建正式会话；其临时启动资源、诊断和必要审计有独立归属，退出只清理确认属于本次的资源，持久环境不删除。
- 第一条有效开发请求原子保存正式身份与请求状态，再调用Agent；消息和技能执行共用准入。保存失败调用0次；首执行失败仍有正式记录。首次初始化失败是否已有正式记录取决于是否已接受有效提交，不删除已提交现场。
- 一个正式ID绑定同一项目、Agent及原生上下文；同一会话忙碌时新执行立即拒绝，不排队、不打断，不按客户端设置所有权。重复事件不重复绑定/执行，断开/提交竞争有确定结果；未收到回复不等于未接受。
- 前端退出只停止观察，已接受开发及采集继续；显式停止才停止本会话执行。未开始开发的新启动离开要收尾专用资源，已有正式会话只读退出不按空启动处理。
- chat --json --input-json保持网页/脚本角色，扩展请求类型和能力回执；正规session事件只能在正式身份可靠保存后输出。真实消息、工具、状态及错误使用既有有界事件源/游标，不另开网页模型API。
- 增量尽力实时展示，不支持时显示完整消息。工具事件缺失明确说明覆盖边界，不能把消息投影当作完整行为审计。
- 技能来自当前Agent原生机制；列出与调用分别报告真实支持情况。接口缺失可明确不支持，不能用提示词拼接冒充原生调用；切换Agent允许技能列表不同，不能切换同一会话的Agent身份。
- 显式恢复需确认结构化Agent后台/原生上下文实际可用；容器running和保存metadata不足以成功。不通过发prompt探活，不自动重试已保存但不确定执行的请求。
- review <session-id>及网页显式审查复用同一独立审查链，冻结代码和行为证据；旧review <task-id> --file <path>语义保留。配置关闭如实说明未执行，不伪造通过。
- Webcoding沿现有认证、项目授权、历史及审查入口；普通文字命令与技能由公共协议处理，不要求首版新增专门技能面板，不修改其他Agent业务。

## Behavior Contract

- System under test：统一逐行终端、JSON/网页入口、正式会话、worker、三Agent结构化适配及独立审查。
- Trigger/input：打开、只读能力查询、消息/技能提交、重复/并发提交、退出、停止、恢复及显式review。
- Collaborators：Docker、原生Agent/技能、可信项目配置、文件存储/原子租约、事件/审计、持久环境及宿主独立审查Agent。
- Observable result：空查看无正式会话、提交先保存、同原生上下文跨入口、断开继续、实际Agent就绪、真实技能能力及可定位的独立审查结论。
- Failure visibility：终端/JSON/网页明确错误和非成功状态；区分保存、准备、鉴权、协议、运行、恢复和审查阶段，保留脱敏错误链与证据缺口。
- Forbidden shortcuts：原生TUI fallback、先执行后保存、拼接提示冒充技能、直接shell、宿主AI转述、伪造流式/历史、自动重放、另开线程冒充恢复、把开发成功当审核通过。

## Testing Decisions

- 在请求校验/首次持久化、原子准入、能力适配、生命周期、JSON事件、行输入及网页鉴权这些公共边界先红后绿。测试观察文件、请求次数、身份和实际回执，不镜像内部函数。
- 故障注入：写失败执行0次；Agent失败留正式记录；重复/并发不串线；未知命令/技能不执行；容器running但Agent失败不成功。竞态用屏障，避免靠sleep碰运气。
- 先例：session-operation、session-json-cli、session-runtime、session-review系列测试；真实CLI与本机假接口可证明传输/状态，不证明远程上下文语义。
- 三Agent分别验证首次创建、原生恢复和技能支持。U01是事实前置，不能把原生!缺口继续当结构化入口不可行，也不能跳过真实结构化失败。
- 保留direct/isolated、非Git、持久环境、MCP、旧审核/V1历史识别、网页其他Agent回归。无新增数据库/Redis需求，不增加CHECK/ENUM；复用应用层Schema。
- 中文注释说明函数与关键顺序；在首次保存、断线不取消、恢复就绪处保留简短错误示范。源码/测试<500行，每片约400差异/≤4主文件，删除也计数。
- 完成后两仓运行pnpm lint、pnpm check、pnpm test、pnpm build；更新devdocs及结构/索引，真实行为审核与代码扫描按原流程执行。

## Architecture Impact

Impact：required。触发公开终端替换、请求及能力接口、身份/生命周期、并发、恢复与错误语义。来源按.rope/routes.md沿用devdocs与当前决定台账，不另造重复架构树。

| ID | Source / status | Scope / disposition | 不变量与禁止捷径 | Required evidence / Applies to | 文档与冲突 |
| --- | --- | --- | --- | --- | --- |
| A1 | grill-decisions D1/D7/D11/D21/D23，active；旧完整TUI要求superseded | 终端/网页入口；supersede原生显示，inherit外部MCP委派 | 开发在容器，不引宿主协调AI/网页模型通道；不回退原生旁路 | B19、UE1/UE2；U01/U06–U08/U12/U14–U16/U18–U22 | recorded；无产品冲突 |
| A2 | D15/D17/D19/D24，session存储与operation，active | 正式身份/请求/事件；extend | 先保存后执行，同ID同上下文；不客户端锁、不双执行、不用内部资源冒充正式会话 | B02/B16/B17/B20、UE1–UE3；U02–U14/U17/U18 | recorded；U01已证本机结构化协议，真实模型仍待验收 |
| A3 | D8/D10/D20及持久环境，active | 生命周期；inherit并适配结构化后台 | 空查看清理专属资源，环境留；已接受断开继续；无daemon/重放/误杀 | B03/B15/B18、UE1/UE3；U03/U04/U12/U14/U16/U17 | recorded；无产品冲突 |
| A4 | D2–D6/D9/D13/D14及review/user-reporting，active | 独立审查；inherit | 固定证据、关闭配置尊重、版本绑定、报告输出与凭据隔离；不将运行成功当审核通过 | B05–B08、UE5；U12/U13/U16/U18/U26 | recorded；旧真实验收缺口保留 |
| A5 | D3/D6/D7/D17及project-access/behavior-policy/relay-setup，active | 访问/配置/旧接口；inherit | direct不回滚、isolated不绕审核、可信授权不扩展、原生历史与MCP保留 | B09/B10、UE5；全部 | recorded；无产品冲突 |
| A6 | AGENTS、routes及D21–D25，active | 协作和新能力；inherit/extend | host-managed、不自动提交、中文注释/小文件；技能由原生能力而非新管理器 | B20/B23、UE4/UE6；全部 | recorded；本轮Contract Note已确认，待最终检查 |

New decision candidate：无高风险待决产品项。协议能力和实际文件预算属于工程补证；需新依赖、权限或改变已确认行为时停止并报告，不静默例外。

## Constraint Bundle

Decision sources/status：D1–D25按当前台账处置；D21替代完整TUI要求，D23–D25替代D22绝对禁止兼容的范围；其余有效不变量继承。Scope为统一输入全部切片/真实验收/verify。Public seams为CLI/JSON、请求与能力Schema、会话存储/准入、Agent结构化适配、worker/审计、Webcoding认证及独立审查。

| ID | 不变量及禁止捷径 | Applies to | Acceptance evidence |
| --- | --- | --- | --- |
| C01 | 直连沙箱开发Agent，外部MCP委派保持 | U06–U18 | B19/B10、UE1/UE2/UE5 |
| C02 | 稳定外部ID对应同项目/Agent/原生上下文，保留历史 | U02–U18 | B02/B16/B18、UE2/UE3 |
| C03 | 统一原子准入，忙即拒绝，无队列/客户端所有权 | U04/U12–U18 | B04/B06/B17、UE2/UE3/UE5 |
| C04 | 由D21替换原生显示要求：终端逐行、网页聊天，结构化事件不是ANSI屏幕 | U06–U18 | B19、UE1/UE2 |
| C05 | 已接受断开继续，无专用daemon，停止与退出分开 | U03/U04/U12/U14–U18 | B03/B15、UE3 |
| C06 | 显式review才独立审查，代码与行为分开，冻结配置不擅开 | U12/U13/U16/U18/U26 | B05/B06、UE5 |
| C07 | 审查失败可补审、旧报告不覆盖新版本，中断明确 | U12/U17/U26 | B07/B08/B18、UE3/UE5 |
| C08 | 开发/审查凭据隔离，错误和证据脱敏 | 全部 | B09、UE5 |
| C09 | 旧CLI/MCP/V1识别及其他网页Agent兼容 | U13/U16/U18–U26 | B10、UE5 |
| C10 | 真实增量尽力展示，不伪造流式 | U06–U18 | B11/B19、UE1/UE2 |
| C11 | direct/isolated、持久环境和无Git保持既有语义 | U03/U04/U12/U17/U26 | B09、UE3/UE5 |
| C12 | 中文注释/小文件/小切片、两仓检查与devdocs、不自动提交推送 | 全部 | UE6、verify |
| C13 | 写入与审查冻结一致；统一提交无旁路；缺事件不假称完整审计 | U04/U12–U18 | B06/B19、UE3/UE5 |
| C14 | 启动资源与正式会话分开；消息/技能先保存再执行，失败不执行 | U02–U18 | B15–B17/B20、UE1/UE3/UE4 |
| C15 | 空启动只清理确认专属资源；已有正式/已接受工作不误杀 | U03/U04/U12/U14/U16 | B15/B17、UE1/UE3 |
| C16 | 真实Agent/原生历史可用才恢复成功，不用prompt探活 | U01/U05–U08/U17/U18 | B18、UE3 |
| C17 | 自有逐行输入及统一结构化控制，无TUI fallback/直接shell/宿主协调AI | 全部 | B19、UE1/UE2 |
| C18 | 技能来自所选Agent，缺能力明确提示，不拼提示词冒充或另建技能系统 | U01/U02/U09–U15/U18 | B20/B23、UE4 |

Open conflicts：产品冲突已由D21–D25明确处置；U01已证本机结构化协议，真实入口和模型仍待验收；当前Contract Note已确认。没有待批准的新依赖或权限。

## Gate Decisions

- G0 approved：沿用隔离合成目录、真实本机CLI、假凭据/回环接口及测试自有Docker。风险local-write；验证后清理归属资源，保留脱敏证据。不操作用户项目容器、凭据或生产历史，不新增系统包/依赖/权限。
- G1 approved但配置仍缺：Codex、Claude Code、OpenCode原专用测试配置各最多两轮简短合成对话，独立审查最多两次；不重置预算。风险可能计费，轮数不等于请求数/金额上限；缺配置blocked，不借生产档案，不无限重试。通过须证明真实上下文与审查结果。
- G2 approved：两仓检查及必须真实验收通过后，仅发布既有Webcoding目标服务；复用一次性重启续接。风险production；核对HTTP、入口、图标及真实操作，只输出必要启动字段。不重复重启、改其他服务或自动远端部署。当前仍blocked，不因计划完成重启。
- G3 inherit：此前已批准并安装ws及类型依赖的事实保留；可按引用清理不用的实现，但本轮不新增依赖或擅自升级。移除依赖须确认全项目无引用并纳入小切片。
- Contract Note approved：用户已确认五条交付摘要，进入go；没有自动commit/push授权。工作区保留已有候选及用户修改，host-managed共享模式。

## References / Execution

- 决定：grill-decisions.md D19–D25；历史合同：prd-native-history.md。
- 当前任务：unified-input-tasks.md；提纲：slice-outline.md；定位：map.md；原生反例：capabilities.md。
- 真实验收：e2e.md UE轮；旧S/R进度和旧E/RE失败保持历史，不重标成功。原生renderer不再是新验收要求，结构化恢复等仍须实际补证。
- U01探针按职责拆a/b、U10b补齐实际Claude只读就绪协议、U16装配/测试及U19–U21/U22原生清理按文件预算拆子片，产品范围不变；36实施单元、23依赖波次、最大宽度3。父串行维护进度/审核，最多3个归属不重叠实施叶同时执行。
- 完成所有片后代码扫描和真实行为双审，再verify。未通过实际验收、缺配置未豁免或功能文档未更新时不标完成，不发布。
