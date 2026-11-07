# 统一输入实施任务、审核与进度

状态：D21–D25及U01–U26提纲已确认；当前PRD五条Contract Note已由用户选择1确认。U01–U25已完成；U26检查、代码双审与记录范围的G0验收通过，G1专用配置缺失，发布blocked。旧S/R任务只作历史，不按原生TUI方向续跑。

## 接手顺序与文件结构

先读prd.md当前合同/C01–C18、grill-decisions.md D19–D25、map.md及capabilities.md的证据边界，再选依赖已满足的切片。src/terminal为逐行输入/呈现及正式记录；src/sessions为请求/能力、worker、环境、审计/恢复/独立审查；src/agents/sessions为各Agent结构化协议和原生技能；Webcoding的srv为已认证CLI接入，scripts/tests为测试入口。临时探针证据写.local/evidence，不进公开Git。

webcoding:表示关联检出目录；路径及操作规范见.local/devdocs/index.md，修改网页前先读其AGENTS。下列未存在文件是计划新增，不代表当前实现。旧源码不能直接按新文档宣称功能已完成。

## 开发与执行规则

- 每片≤4主要文件、约400差异行（含移动/删除），源码和测试<500行；函数、关键步骤及设计意图写中文注释。首次保存/断开/恢复处保留简短错误示范。
- 实施者只改allowlist。需第五文件或超差异预算时先重切并调整依赖，不顺手改无关内容。同波次只运行文件不重叠的片，父串行维护本包/map/review等元数据。
- TDD：先写公共边界的失败用例，记录真实红命令/原因；最小实现后运行绿命令/相关类型检查。只删确认无调用代码的片不写镜像测试，以引用检查及保留行为测试验证；文档片豁免TDD但核对真实入口。
- 先扩展契约、逐Agent迁移，再清理旧路径；每阶段保持检查可运行。优先现有Schema/原子锁/事件/派发，不新增Redis、数据库ENUM/CHECK或依赖。
- 既有未提交候选和用户改动保留，host-managed，不自动commit/push。新增依赖/权限/收费范围触发停止，不将未知协议作为随意改需求的理由。
- 每片记录红绿证据；最终两仓pnpm lint && pnpm check && pnpm test，并pnpm build。完成更新devdocs、索引和结构；必须真实验收未过不发布。

## Behavior Matrix

| ID | Given / When | Then | 证据与范围 |
| --- | --- | --- | --- |
| B01/B14 | 原生TUI要求已被D21替代 | 不再要求完整原生渲染；新行为按B19验收，旧失败不改passed | 旧E1历史，当前UE1 |
| B02 | 正式会话从终端/网页续接 | 同外部ID、原生上下文及环境，无分叉 | UE2；身份/回执测试 |
| B03 | 已接受工作期间前端离开 | 开发和采集继续，无新daemon | UE3；生命周期测试 |
| B04 | 开发/审查忙碌时再提交 | 立即拒绝，不排队不打断，不按客户端抢权 | UE3/UE5；并发屏障 |
| B05/B06 | 空闲显式review/忙时review | 固定证据独立审查；忙时拒绝，配置关闭如实说明 | UE5；现有审查回归 |
| B07/B08 | 审查失败/新开发/中断 | 可补审；旧报告不覆盖新证据；中断提醒 | UE3/UE5 |
| B09 | direct/isolated或非Git项目运行 | 既有授权、交付、持久环境及凭据隔离不改变 | UE5 |
| B10 | 旧CLI/MCP/V1历史及其他网页Agent | 兼容语义保留，V1不误续接，其他Agent无意外改动 | UE5 |
| B11 | 实际支持/不支持增量 | 尽力及时转发；允许完整消息，不假流式 | UE1/UE2 |
| B12 | 空输入、非法ID、路径越界、缺配置/原生ID或依赖未就绪 | 明确拒绝/初始化提示，不误报已执行/恢复/审查，不泄密 | UE1/UE3/UE5及边界测试 |
| B13 | 重复请求/游标、并发收尾或重连 | 不重复启动开发/采集或重放；review重试可有新尝试但不并发写同证据 | UE3/UE5及并发测试 |
| B15 | 新打开仅帮助/列表/未提交草稿后离开 | 无正式记录；专属临时资源结束，环境与必要日志留存 | UE1/UE4 |
| B16 | 首次有效消息/技能提交 | 先保存身份/请求再执行；保存失败0执行；执行失败记录仍在 | UE1/UE3/UE4 |
| B17 | 重复/双入口/关闭与首提交竞争 | 单一准入结果，不重复执行/绑定，不误杀已接受工作 | UE3；屏障测试 |
| B18 | 公开恢复已有会话 | Agent真实可用才成功；失败非零，保留同原生身份，不重放 | UE3 |
| B19 | 默认CLI进入并多轮提交 | 自有逐行输入，通过共用结构化通道与沙箱Agent对话，消息/工具/状态如实展示 | UE1/UE2 |
| B20 | 查看或执行所选Agent技能 | 原生能力支持才调用，不支持明确提示；只读不激活，执行准入先保存 | UE4 |
| B21/B22 | 本轮未定义 | N/A，保留编号空位，不构造不存在的需求 | 无测试义务 |
| B23 | 帮助/状态/退出/停止/审查/技能或未知命令 | 已知命令路由明确；未知拒绝，不shell执行；压缩不阻塞首版 | UE1/UE4 |

## 实施切片

### U01：结构化能力与技能补证（U01a/U01b）

- Status：passed；Kind：vertical / 组成片；Blocked by：无。
- Matrix：B19/B20/B23/B18；Constraints：C12、C16/C17/C18（及全局不变量）。
- Owned files：U01a仅`scripts/structured-probe-support.ts`（假协议与专属进程清理）；U01b为`scripts/probe-structured-sessions.ts`、`tests/unit/structured-session-probe.test.ts`、`.rope/issues/direct-terminal/capabilities.md`。两片顺序落地，各自遵守差异预算。
- Goal / Public behavior：首次创建/恢复、执行结束、技能发现/调用均按真实CLI或服务实测；不支持如实记录。
- Tests / Required evidence：分别实跑首次创建、结构化完成/失败、原生历史恢复及技能发现/调用；记录协议/版本/真实证据，未支持不冒充支持；假模型0远程。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U02：统一请求与能力契约

- Status：passed；Kind：contract；Blocked by：U01。
- Matrix：B19/B20/B23；Constraints：C12、C17/C18（及全局不变量）。
- Owned files：`src/sessions/requests.ts`；`src/sessions/capabilities.ts`；`src/agents/sessions/contract.ts`；`tests/unit/session-requests.test.ts`。
- Goal / Public behavior：区分消息、技能执行和只读能力；终端/网页使用同一协议，拒绝未知命令。
- Tests / Required evidence：消息/技能/能力查询严格校验；空输入、未知命令、超限及非法技能ID拒绝，序列化回执无歧义。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U03：无正式会话的只读启动上下文

- Status：passed；Kind：wide-refactor-expand；Blocked by：U01。
- Matrix：B15/B20；Constraints：C12、C14/C15（及全局不变量）。
- Owned files：`src/sessions/startup-context.ts`；`src/sessions/environment.ts`；`tests/unit/session-startup-context.test.ts`。
- Goal / Public behavior：打开及帮助/技能列表可用，不为查能力制造正式记录；诊断和资源有归属。
- Tests / Required evidence：打开/只读列表无session.json；临时资源有归属；配置/镜像缺失提示且不猜凭据，不借用生产任务。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U04：首次提交原子保存与准入

- Status：passed；Kind：vertical / 组成片；Blocked by：U02/U03。
- Matrix：B16/B17；Constraints：C12、C02/C03/C14（及全局不变量）。
- Owned files：`src/terminal/session.ts`；`src/sessions/activation.ts`；`src/sessions/operation.ts`；`tests/unit/session-activation.test.ts`。
- Goal / Public behavior：验证请求后先保存身份/请求，再准入；保存失败执行0次，失败执行仍留记录。
- Tests / Required evidence：保存失败执行0次；重复/双入口首次准入只一个成功；已保存执行失败仍保留身份；关闭和提交屏障两种顺序不误杀。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U05：Codex协议小范围提取

- Status：passed；Kind：prefactor；Blocked by：U02/U03。
- Matrix：B19/B18；Constraints：C12、C12/C16/C17（及全局不变量）。
- Owned files：`src/agents/sessions/codex-gateway.ts`；`src/agents/sessions/codex-rpc.ts`；`tests/unit/codex-rpc.test.ts`。
- Goal / Public behavior：先分离已有RPC关联/错误传播，为纯结构化路径及清理控制预算；公开行为不变。
- Tests / Required evidence：RPC关联、未知应答、断开/初始化错误维持原错误语义；不通过测试断言内部拆分形状。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U06：Codex纯结构化会话

- Status：passed；Kind：vertical / 组成片；Blocked by：U04/U05。
- Matrix：B19/B16/B18；Constraints：C12、C02/C14/C16/C17（及全局不变量）。
- Owned files：`src/agents/sessions/codex-driver.ts`；`src/agents/sessions/codex-gateway.ts`；`src/agents/sessions/codex.ts`；`tests/unit/session-codex.test.ts`。
- Goal / Public behavior：正常首次创建，已有历史真实恢复，不创建原生renderer、不补pristine历史。
- Tests / Required evidence：实际新建走正常创建，已有ID真实恢复；不启动renderer；失败/超时释放或留下可见故障；实际历史缺失非零。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U07：Claude纯结构化会话

- Status：passed；Kind：vertical / 组成片；Blocked by：U04。
- Matrix：B19/B16/B18；Constraints：C12、C02/C14/C16/C17（及全局不变量）。
- Owned files：`src/agents/sessions/claude-driver.ts`；`src/agents/sessions/claude-code.ts`；`tests/unit/session-claude.test.ts`。
- Goal / Public behavior：通过print/stream-json路径提交，控制层已准入后执行，无空闲PTY与原生!旁路。
- Tests / Required evidence：只启动结构化CLI，无PTY/hook准入依赖；真实身份和结束/错误解析，非零及零轮次不伪装成功。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U08：OpenCode纯结构化会话

- Status：passed；Kind：vertical / 组成片；Blocked by：U04。
- Matrix：B19/B16/B18；Constraints：C12、C02/C14/C16/C17（及全局不变量）。
- Owned files：`src/agents/sessions/opencode-driver.ts`；`src/agents/sessions/opencode-bridge.ts`；`tests/unit/session-opencode.test.ts`。
- Goal / Public behavior：复用serve原生上下文，直接受控结构化请求，不初始化attach/TUI代理。
- Tests / Required evidence：serve健康检查不等于轮次执行；结构化请求绑定同ID；完成/错误边界明确，无attach代理启动。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U09：Codex原生技能适配

- Status：passed；Kind：vertical / 组成片；Blocked by：U06。
- Matrix：B20；Constraints：C12、C18（及全局不变量）。
- Owned files：`src/agents/sessions/codex-skills.ts`；`src/agents/sessions/codex-driver.ts`；`tests/unit/codex-skills.test.ts`。
- Goal / Public behavior：列出及调用实际可用原生技能；能力缺失明确提示，不拼提示词冒充。
- Tests / Required evidence：只读发现不激活；调用原生能力的请求准确；不存在/不支持/失败明确，不拼接文本替代。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U10：Claude原生技能适配

- Status：passed；Kind：vertical / 组成片；Blocked by：U07。
- Matrix：B20；Constraints：C12、C18（及全局不变量）。
- Owned files：`src/agents/sessions/claude-skills.ts`；`src/agents/sessions/claude-driver.ts`；`tests/unit/claude-skills.test.ts`。
- Goal / Public behavior：沿实际结构化能力发现/调用Claude技能；不存在接口时返回明确不支持。
- Tests / Required evidence：用真实能力证据决定支持等级；缺接口明确不支持；执行错误保留原生ID与阶段，无提示词伪调用。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U10b：Claude无提示词就绪探查

- Status：passed；Kind：vertical / 工程补证后置小片；Blocked by：U10。
- Matrix：B18/B12；Constraints：C12/C14/C16/C17。
- Owned files：`src/agents/sessions/claude-readiness.ts`；`tests/unit/claude-readiness.test.ts`；`src/agents/sessions/claude-driver.ts`。
- Goal / Public behavior：复用实际stream-json control initialize，在不发prompt的情况下确认已有历史可用；首次正式提交后也可探活CLI，不凭元数据猜测。
- Tests / Required evidence：匹配control_response success与idle；缺历史result错误、提前退出、超时均拒绝；有界清理专属进程，不停容器，不重放、不换ID。
- Verification：红→绿定向测试、局部lint与父波末check；实际本机证据见unified-u10，未调用真实模型。
- Stop conditions：原有约400差异/4文件预算及权限范围不变；无真实控制证据不得降级成文件检查成功。

### U11：OpenCode原生技能适配

- Status：passed；Kind：vertical / 组成片；Blocked by：U08。
- Matrix：B20；Constraints：C12、C18（及全局不变量）。
- Owned files：`src/agents/sessions/opencode-skills.ts`；`src/agents/sessions/opencode-driver.ts`；`tests/unit/opencode-skills.test.ts`。
- Goal / Public behavior：沿原生能力发现/调用技能，保留实际Agent差异。
- Tests / Required evidence：列表/执行按OpenCode真实接口，技能调用受统一准入；未知技能拒绝且请求次数0。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U12：worker及运行期审计迁移

- Status：passed；Kind：vertical / 组成片；Blocked by：U09/U10b/U11。
- Matrix：B16/B17/B19；Constraints：C12、C03/C08/C13/C14/C17（及全局不变量）。
- Owned files：`src/sessions/runtime.ts`；`src/sessions/runtime-driver.ts`；`src/sessions/worker.ts`；`tests/unit/session-runtime.test.ts`。
- Goal / Public behavior：三个结构化驱动接入同一worker；启动、审计、正式激活、后台生命周期一致。
- Tests / Required evidence：审计先于可执行请求；三驱动不初始化native路径；开发侧无审查凭据；失败/退出保留现场。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U13：统一命令与技能分发

- Status：passed；Kind：vertical / 组成片；Blocked by：U12。
- Matrix：B20/B23；Constraints：C12、C03/C14/C18（及全局不变量）。
- Owned files：`src/sessions/commands.ts`；`src/sessions/worker-api.ts`；`src/sessions/worker.ts`；`tests/unit/session-commands.test.ts`。
- Goal / Public behavior：帮助/状态/能力读取不激活；技能执行与普通消息共用准入；未知命令不执行。
- Tests / Required evidence：帮助/状态/技能列表不激活，执行技能与消息共用锁；未知命令不发Agent请求；忙碌不排队。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U14：JSON身份与进度回执

- Status：passed；Kind：vertical / 组成片；Blocked by：U13。
- Matrix：B16/B17/B19；Constraints：C12、C02/C10/C14/C17（及全局不变量）。
- Owned files：`src/sessions/json-command.ts`；`src/sessions/json-protocol.ts`；`tests/unit/session-json-cli.test.ts`；`tests/unit/session-json-protocol.test.ts`。
- Goal / Public behavior：首次有效提交才回可靠正式ID，真实事件持续输出，EOF不停止已接受请求。
- Tests / Required evidence：只在正式保存后发送ID；失败阶段与非零输出；EOF/输出断开不取消已接受工作；游标续接不重复事件。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U15：逐行终端交互

- Status：passed；Kind：vertical / 组成片；Blocked by：U14。
- Matrix：B19/B23；Constraints：C12、C10/C17/C18（及全局不变量）。
- Owned files：`src/terminal/line-input.ts`；`src/terminal/line-output.ts`；`src/terminal/line-session.ts`；`tests/unit/terminal-line-session.test.ts`。
- Goal / Public behavior：逐行多轮输入，展示消息/工具/状态/错误；不发送直接shell命令。
- Tests / Required evidence：逐行多轮、空输入、退出、停止及错误；显示真实消息/工具/状态，原终端滚动不被全屏模式接管；不伪造增量。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U16：CLI装配与空退出

- Status：passed；Kind：vertical / 组成片；Blocked by：U15。
- Matrix：B15/B16/B19/B10；Constraints：C12、C05/C09/C14/C15/C17（及全局不变量）。
- Owned files：`src/terminal/command.ts`；`src/sessions/startup-close.ts`；`tests/unit/terminal-command.test.ts`。
- 预算内子片：U16a先装配command/startup-close及command单测（3文件）；U16b再迁移terminal-cli测试与tests/helpers/terminal-worker.ts（2文件），测试fixture从submit改为typed execute。每片≤约400差异，不为旧fixture保留产品旁路。
- Goal / Public behavior：默认relay进入逐行界面；只读退出无正式记录；已提交离开继续，review子命令兼容。
- Tests / Required evidence：实际默认入口使用line-session；空查看退出无正式记录，专属资源收尾；已提交断开继续；旧review --file仍按任务语义。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U17：恢复等待结构化Agent就绪

- Status：passed；Kind：vertical / 组成片；Blocked by：U12。
- Matrix：B18；Constraints：C12、C02/C07/C16（及全局不变量）。
- Owned files：`src/sessions/recovery.ts`；`src/cli/session-commands.ts`；`src/sessions/readiness.ts`；`tests/unit/session-recovery.test.ts`。
- Goal / Public behavior：公开恢复命令成功前检查真实后台/原生上下文，不隐式发prompt，不只看容器。
- Tests / Required evidence：容器running但Agent初始化失败必须非零；历史缺失不新建；成功实际可发结构化请求，探活不发prompt、不重放。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U18：Webcoding共享请求与技能

- Status：passed；Kind：vertical / 组成片；Blocked by：U14/U17。
- Matrix：B02/B10/B20；Constraints：C12、C01/C09/C14/C17/C18（及全局不变量）。
- Owned files：`webcoding:srv/relay-runtime.ts`；`webcoding:srv/relay-session-link.ts`；`webcoding:scripts/tests/relay-runtime.test.ts`；`webcoding:scripts/tests/relay-session-link.test.ts`。
- Goal / Public behavior：沿已认证通道读同一能力/历史并提交消息或技能；无独立模型接口。
- Tests / Required evidence：真实ID只在首提交可靠保存后绑定；认证/项目边界保持；输入命令与技能走同一CLI协议，其他Agent回归。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U19：清理Codex原生renderer代理残留

- Status：passed；Kind：wide-refactor-contract；Blocked by：U16/U18。
- Matrix：B19/B10；Constraints：C12、C02/C09/C17（及全局不变量）。
- Owned files：`src/agents/sessions/codex-gateway.ts`；`src/agents/sessions/codex-driver.ts`；`tests/unit/session-codex.test.ts`。
- 预算内子片：U19a先删除确认仅服务WS/pristine的旧测试（保留结构化结束/故障测试）；U19b再清理gateway/driver原生分支及必要测试调整。U19b暂保留无执行作用的输入字段；U19c再清兼容字段、runtime-driver装配及session-codex/session-runtime测试（4文件约50差异；同文件同步去OpenCode旧装配断言，并把过时submit期望改为统一execute）。各片≤约400差异，不合并豁免。
- Goal / Public behavior：不留可绕过统一入口的原生启动路径；实际原生历史保持。
- Tests / Required evidence：引用搜索确认仅删除native部分；保留结构化RPC/真实历史；旧native请求明确拒绝，实际结构化回归。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U20：清理Claude原生hook桥残留

- Status：passed；Kind：wide-refactor-contract；Blocked by：U16/U18。
- Matrix：B19/B10；Constraints：C12、C09/C17（及全局不变量）。
- Owned files：`src/agents/sessions/claude-bridge.ts`；`src/agents/sessions/claude-driver.ts`；`tests/unit/session-claude.test.ts`。
- 预算内子片：U20a先删确认废弃的原生hook/PTY专属测试；U20b删除旧factory/broker脚本；U20c删除已无引用claude-bridge与剩余专属测试段。claudeLaunch/message及结构化测试保留；每片≤约400差异。
- Goal / Public behavior：不保留仅服务PTY准入的hook桥和旧兼容分支，不改实际技能/工具能力。
- Tests / Required evidence：只删服务原生PTY的hook桥及相应测试，保留结构化失败检测与技能能力，存量身份/历史不动。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U21：清理OpenCode原生代理残留

- Status：passed；Kind：wide-refactor-contract；Blocked by：U16/U18。
- Matrix：B19/B10；Constraints：C12、C09/C17（及全局不变量）。
- Owned files：`src/agents/sessions/opencode-driver.ts`；`src/agents/sessions/opencode-bridge.ts`；`tests/unit/session-opencode.test.ts`。
- 预算内子片：U21a先删仅proxy/attach/原生准入的测试段，保留serve/结构化完成和错误；U21b再清理driver/bridge的attach/proxy代码及必要引用。每片≤约400差异。
- Goal / Public behavior：移除仅服务attach的代理/通道测试，保留serve/结构化请求。
- Tests / Required evidence：删除attach/proxy及仅原生相关分支，保留serve/同步结构化请求的失败与完成验证。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U22a：删除原生终端前端与专属测试

- Status：passed；Kind：wide-refactor-contract；Blocked by：U19b/U20c/U21b。
- Matrix：B19/B10；Constraints：C12、C09/C17（及全局不变量）。
- Owned files：`src/terminal/frontend.ts`；`src/terminal/native-input.ts`；`tests/unit/terminal-native.test.ts`。
- Goal / Public behavior：旧native控制命令明确不支持，删除无调用的frontend/native-channel/transport分支。
- Tests / Required evidence：迁移后引用搜索0，删除frontend/native-input及terminal-native专属测试；已有line入口测试继续覆盖用户行为。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U22b：删除无引用原生通道服务

- Status：passed；Kind：wide-refactor-contract；Blocked by：U22a。
- Matrix：B19/B10；Constraints：C12、C09/C17（及全局不变量）。
- Owned files：`src/sessions/native-channel.ts`；`src/sessions/worker.ts`；`src/sessions/worker-api.ts`；`tests/unit/session-worker.test.ts`。
- Goal / Public behavior：旧native控制命令明确不支持，删除无调用的frontend/native-channel/transport分支。
- Tests / Required evidence：删除确认无引用native-channel；worker旧native请求固定拒绝并删除driver.native/transport guard依赖，保留Schema以明确拒绝旧调用；检查通用Docker交互仍保留；引用/类型检查通过。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U22c：收缩通用PTY挂接与遗留测试

- Status：passed；Kind：wide-refactor-contract；Blocked by：U22b。
- Matrix：B19/B10；Constraints：C12、C09/C17（及全局不变量）。
- Owned files：`src/sessions/attach.ts`；`src/sessions/transport.ts`；`tests/unit/session-transport.test.ts`；`src/docker/interactive.ts`（仅更新指向已删transport的过时注释，保留实现）。
- Goal / Public behavior：旧native控制命令明确不支持，删除无调用的frontend/native-channel/transport分支。
- Tests / Required evidence：删除无调用attach/transport及相关测试段；session-transport.test内独立Docker交互测试必须保留，不能整文件盲删。
- Verification：引用检查、相关保留测试和pnpm check；不为纯删除写镜像测试。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U23：主仓操作与功能文档

- Status：passed；Kind：vertical / 组成片；Blocked by：U22c。
- Matrix：B15–B20/B23；Constraints：C12、C12/C14/C16/C17/C18（及全局不变量）。
- Owned files：`README.md`；`devdocs/terminal.md`；`devdocs/usage.md`；`devdocs/persistent-environments.md`。
- Goal / Public behavior：更新逐行使用、命令、技能、首次提交和失败恢复说明。
- Tests / Required evidence：操作说明与真实CLI帮助/回执核对；技能差异/未验收项明确，功能完成后更新devdocs。
- Verification：文档与真实操作/链接核对；TDD豁免，禁止把计划写成已实现。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U24：结构索引与验证记录

- Status：passed；Kind：vertical / 组成片；Blocked by：U23。
- Matrix：全部；Constraints：C12、C12（及全局不变量）。
- Owned files：`AGENTS.md`；`devdocs/structure.md`；`devdocs/implementation-validation.md`；`.local/devdocs/terminal-delivery.md`。
- Goal / Public behavior：记录当前结构和真实证据，旧失败仍可追溯。
- Tests / Required evidence：文件树/索引实际存在，证据状态有来源；不删除失败历史或把未跑记通过。
- Verification：文档与真实操作/链接核对；TDD豁免，禁止把计划写成已实现。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U25：网页操作文档

- Status：passed；Kind：vertical / 组成片；Blocked by：U24。
- Matrix：B02/B20；Constraints：C12、C12/C18（及全局不变量）。
- Owned files：`webcoding:.devguide/relay-sandbox.md`；`webcoding:.devguide/project.md`；`webcoding:AGENTS.md`。
- Goal / Public behavior：网页技能/统一会话行为与当前实现一致，不混写尚未验收能力。
- Tests / Required evidence：网页文档描述现有统一协议和能力限制，私有配置路径仅放.local。
- Verification：文档与真实操作/链接核对；TDD豁免，禁止把计划写成已实现。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

### U26：最终真实验收及既有发布

- Status：blocked（G1专用配置缺失，未发布）；Kind：vertical / 组成片；Blocked by：U25。
- Matrix：全部；Constraints：C12、C12/C16/C17/C18（及全局不变量）。
- Owned files：`.rope/issues/direct-terminal/e2e.md`；`.rope/issues/direct-terminal/review.md`；`.rope/issues/direct-terminal/verify.md`；`.local/devdocs/terminal-delivery.md`。
- Goal / Public behavior：两仓最终检查与真实行为审核完成后才按原范围发布，缺配置保持阻塞。
- Tests / Required evidence：两仓lint/check/test/build；双审逐矩阵行为验证UE1–UE6；原授权内发布且只核对必要字段，未通过不重启。
- Verification：先红后绿；pnpm exec vitest run <本片测试文件>与pnpm check；真实语义见e2e.md。
- Stop conditions：超过约400行/4主文件、无法可靠结构化准入/恢复、需新增权限/依赖或改变合同则停止并报告/重切。技能不支持按已确认能力差异明示，不伪造调用。

## 依赖与预算复核

U22因删除预算拆为a/b/c，范围不变：a删除frontend74行/native-input132行/专属测试169行，约375行；b仅无引用native-channel143行；c清理attach61行/transport79行及session-transport测试相关段，保留其中独立Docker测试，总量约292行以内。实际迁移后再核对，不以此估算豁免上限。

36实施单元，全部串行36单位，最长依赖链23单位，23波次、最大宽度3；数字不是工期。波次：

1. U01a
2. U01b
3. U02、U03
4. U04、U05
5. U06、U07、U08
6. U09、U10、U11
7. U10b
8. U12
9. U13、U17
10. U14
11. U15、U18
12. U16a
13. U16b
14. U19a、U20a、U21a
15. U19b、U20b、U21b
16. U19c、U20c
17. U22a
18. U22b
19. U22c
20. U23
21. U24
22. U25
23. U26
同波次allowlist不共享核心文件；清理片只有在迁移入口都生效后才就绪。所有分支共享上下游，是单一交付链，无独立river。最大3实施叶+父；父串行维护进度/证据。图顺序沿已确认提纲，U22子片为预算内必要细化。

## 审核栏

| 范围 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| D21–D25与U提纲 | 用户已确认 | grill-decisions.md | 详细包已展开 |
| 当前五条Contract Note | 用户已确认 | 用户选择1 | 从U01开始 |
| U01–U25 | passed | 逐片红绿与下方日志 | U26验收 |
| U26 | blocked | 两仓全量检查构建与记录范围G0通过，真实模型配置仍缺 | 补齐G1后才发布 |
| 最终代码扫描/行为审核 | 代码approve；产品blocked | 新静态增量及实际三项delta通过，旧裁定保留 | 完整矩阵与UE轮 |
| 真实模型验收/发布 | blocked | 旧G1配置缺口未消除 | 不以假接口检查冒充通过 |

## 进度日志

- 2026-11-07：用户确认统一输入提纲；展开当前PRD、36实施单元及UE真实验收。旧PRD原文归档prd-native-history.md，S/R失败不覆盖。U22按删除预算拆三片，无产品范围变化。仅改文档，没有模型调用、容器操作、重启或提交推送。

实施时每片追加日期、ID、实际文件、红命令/失败、绿命令/结果、约束证据、风险/阻塞及下一步。失败与未运行同样记录，未实际执行不得写passed。

- 2026-11-07：用户确认当前五条Contract Note，进入rope-go。host-managed保留前轮已登记未提交变更；最大并行3，当前仅U01就绪，计划1实施叶，后续按不重叠归属并行。无自动commit/push，开始基线检查。

- 2026-11-07：基线lint/check通过，317测试通过、57跳过。U01实际本机假接口证明三Agent结构化首建/同ID恢复及上下文延续；原生技能列表可读，专用执行未实证按unsupported处理。U02/U03归属不重叠，并行实施；未调用远程模型或操作用户项目容器。

- 2026-11-07：U01按正常格式整理后预计约450差异行，先重切为U01a假协议/进程生命周期支撑与U01b三Agent补证，分别控制约400行内，不放宽文件长度或压行。仅工程预算拆分，无新增产品行为和授权；U02/U03依赖的三Agent首建/恢复事实已返回，继续并行，最终U01归档待完成。

- 2026-11-07：U02完成，缺模块红后14项绿，消息/技能执行与只读能力严格Schema，4文件约178增量。U03完成，缺模块红后新4项及旧环境9项绿、check通过；可信只读上下文独立startupId不落盘正式身份，不读密钥，资源仅入口内持有。父合跑U02/U03共18项通过。波3 U04原子保存与U05 RPC提取并行实施，归属不重叠。

- 2026-11-07：U01a/b归档完成，两片155/约331行；真实本机三Agent重启或失败后同ID恢复、上下文延续通过，Codex原生skill输入将合成技能内容送入本机模型请求。保留OpenCode中间20秒HTTP超时，不将最终通过当作产品根因修复。2测试/lint/check通过，专属进程与临时目录清理。U04新增原子发布和并发屏障5测试通过、check通过，约228行；U05 RPC提取4新增+4回归通过，约175差异。进入波4 U06/U07/U08三并行，仅迁移结构化路径，旧native待预算清理。

- 2026-11-07：U06纯结构化Codex无WS监听/renderer或pristine历史，严格原生恢复；新增typed inputs/只读RPC供技能适配，Codex+RPC10项通过。U07 Claude纯print factory无hook/PTY，首次失败保持ID，真实result/工具开始/system-init缓存，13项通过；原测试496行，后续技能用新测试。U08 OpenCode纯serve请求、已有ID验证和finish/error检查，无proxy/第二租约，8项通过。各片局部lint通过，父统一check；U09–U11技能适配并行，旧native分支仅待后续清理。

- 2026-11-07：U09 Codex真实列表/原生skill输入适配，技能6项+会话6项绿；U10 Claude真实init技能缓存/调用unsupported，4项绿；U11 OpenCode原生skill列表/调用unsupported，7项绿；三片局部lint通过。U10实际额外补证Claude无prompt control initialize可区分已有历史idle与缺历史exit1，仅本机hello而无messages；为可靠恢复新增预算内U10b helper/测试/driver委托，U12显式依赖该片。仅工程补全既有C16，未扩展产品授权。

- 2026-11-07：U10b完成，Claude真实控制协议提取为独立readiness helper，driver.ready委托；匹配请求与idle，不发prompt，专属进程EOF/超时TERM→KILL并等待，6新增+4技能测试与局部lint通过，约184新增行。U12开始审计/纯驱动装配，控制socket仅在真实就绪后发布。

- 2026-11-07：U12完成纯驱动装配，先审计后初始化，Claude无prompt ready失败收尾，不展开Codex native getter；worker typed execute/capabilities/listSkills接缝保留旧submit。runtime/worker15项通过、局部lint/check通过，3文件约300差异。U13统一命令和逐请求先保存、U17真实Agent恢复就绪并行实施。

- 2026-11-07：清理前按当前真实行数复核：Codex gateway455/测试498、Claude driver421/bridge158/测试496、OpenCode driver385/测试338，不能整片删除。预先将U19/U21拆a测试删除+b代码，U20拆a旧测试+b旧factory+c无引用桥。先保留结构化行为测试再删废弃实现，各片约400差异内，产品与验证范围不变；更新为36实施单元、22波次。

- 2026-11-07：U13完成统一命令/typed execute/只读查询，每次执行持租约先保存accepted请求；未知/unsupported零执行，worker输入262144字节并修socket UTF-8分块，14项测试/lint通过。父发现技能文本参数尾空白被trim，新增断言复现后最小修复，4项绿。U17恢复在协调锁释放后等待真实worker就绪，确认原生/任务/环境绑定，失败interrupted且非零；12项/lint/check绿。U14开始新JSON首次可靠身份与只读回执，关注保存后输出断线仍派发一次。

- 2026-11-07：U14完成activate/readonly JSON回执与phase错误，可靠身份才announce，回执断线仍执行唯一派发，EOF/Abort不stop、显式stop后不重读已关socket；9项/lint/check绿。U13补忙碌技能在能力查询前立即拒绝，屏障红后15项绿、无第二记录或执行。U15逐行终端与U18 Webcoding共享协议接入并行，真实验收/发布仍未通过。

- 2026-11-07：U15完成逐行输入/真实输出/滚动显示，5项红绿、lint/check通过；EOF/退出/信号不stop，控制字符清理。U18 Webcoding原stdin支持typed请求和只读系统通知，仅可靠relay.session绑定身份且拒绝冲突，25项加22项控制/鉴权回归通过、check通过。U16开始装配默认CLI及空退出，不提前创建正式会话。

- 2026-11-07：U16装配发现既有CLI fixture只接受submit，预先拆U16a装配/单测与U16b测试fixture迁移，保持每片文件/差异预算，不在产品保留旧执行旁路；调整35单元、23波次。

- 2026-11-07：清理引用复核发现worker仍从transport引用仅旧native入口使用的guard。预先把U22b扩为4主文件约200差异：旧native固定拒绝、删可执行分支和描述符，再删无引用channel；U22c即可安全删除transport而不引入悬空依赖。

- 2026-11-07：U15补显式sessionId初始只读恢复，新增红后6项绿；U16a/b完成默认逐行入口、延迟JSON新启动、首次保存后宣告、已有后台连接再就绪、专属清理；实际CLI空查看无新会话/无worker命令，9项测试及lint/check通过。开始U19a/U20a/U21a三叶并行，按预算只删旧专属测试。

- 2026-11-07：U19a仅删除Codex WS/pristine专属测试211行，保留结构化故障/恢复，相关14项和lint通过；U20a删除Claude旧factory/PTY及部分bridge专属测试240行，保留解析和纯结构化，7项/lint通过。

- 2026-11-07：U21a删除OpenCode原生proxy/attach专属测试171行，保留结构化4项，lint/check通过。U19b/U20b/U21b开始并行删对应废弃实现；Codex字段、装配及装配测试共5文件，预先新增U19c作下一波4文件参数清理，当前b只删旁路。调整36单元，23波次不变（c与U20c并行）。runtime-driver本wave只由OpenCode叶修改。

- 2026-11-07：U20b删除Claude旧factory及hook/broker 279行，保留结构化仍使用的进程包装器；会话/技能/就绪17项、lint/check通过。并行代码迁移揭示session-runtime旧submit与structuredOnly断言过时，已归入下一波U19c同一装配测试文件，暂红有明确归属。

- 2026-11-07：U19b去Codex WS/pristine/native输入旁路，14项/lint通过；U21b四文件约333差异，删除OpenCode代理/attach/原生准入，保留serve/同IDGET/技能/完成/停止，11项及lint/check通过。U19c集中清过渡接口与两处旧装配测试，U20c删除Claude无引用桥并行开始。

- 2026-11-07：U20c删除无引用Claude bridge158行及专属测试96行，总254删除；相关14项/lint/check通过，src/tests旧桥引用清零，纯结构化与解析验证保留。

- 2026-11-07：U19c四文件约90差异，清Codex旧字段/装配，并修过期测试：旧submit仍先accepted落盘再统一execute，测试检查真实租约和请求文件；29项/lint/check通过。三Agent原生执行分支清理完成，开始U22a删未引用旧前端，后续固定拒绝native后删PTY通道。

- 2026-11-07：U22a严格删除旧frontend/native-input及专属测试375行，终端16项/lint/check通过，native-channel已无外部引用。U22b开始固定拒绝旧native控制并删通道，通用Docker交互和V1历史保留。当前未发现可用rope-reviewer harness预设，最终将使用明确职责的通用新叶，preset_missing，不新增模型覆盖。

- 2026-11-07：U22b四文件约180差异，先红证明旧driver.native仍可能被调用，固定拒绝后0调用；删除channel和worker transport guard/描述符依赖，21项/lint/check通过。U22c最后删除无产品调用的attach/transport，保留独立Docker测试并修过时注释。

- 2026-11-07：U22c四文件约240差异，删除attach/transport及3个专属测试，保留2个Docker交互测试；interactive实现未变，只修过时注释。相关7组34项、lint/check通过，旧通道src/tests引用清零。实现清理结束，U23按当前源码同步操作文档，真实产品终验及模型配置仍待。

- 2026-11-07：U23四文件更新README/terminal/usage/persistent环境文档，按真实源码说明逐行命令、先保存后派发、技能能力、恢复、JSON只读/错误阶段及退出/停止；保留独立审查和MCP/旧审核。链接/围栏核对通过，明确真实产品终验/G1配置仍待、未发布。U24索引/树/记录开始。

- 2026-11-07：U24四文档索引/中文文件树/验证及私有部署状态同步，文件88/235/465/37行，链接有效；旧S/R失败历史保留，当前U实施与尚待真实验收/G1缺配置明确区分。开始U25网页文档同步。

- 2026-11-07：U25 Webcoding三文档同步统一输入/身份/只读/技能/审查边界，链接与源码核对通过，公开内容无本机路径/密钥；旧失败只作历史。U01–U25实施结束，开始两仓lint/check/test/build，之后新scanner/reviewer双审；G1仍缺专用配置，不重启发布。

- 2026-11-07：U26 Webcoding全量lint/check/test/build退出0，794项通过、0失败/跳过；738项既有lint warning非error，未做无关改写或依赖升级。主仓全量测试仍运行，尚未进入最终实际双审。

- 2026-11-07：U26主仓全量lint/check/test/build退出0，84测试文件通过/30跳过，383项通过/57配置跳过，153.19秒；Webcoding794项通过且全链0。构建已更新dist，网站未重启。开始两名新通用叶最终双审：unified_final_scanner只读静态，unified_final_reviewer实际构建产品/测试自有资源，preset_missing；不借G1生产配置，缺项保持blocked。检查输出摘录保存在私有unified-final目录（长输出截断，非完整日志）。

- 2026-11-07：U26静态轴changes_requested：统一审查沿用5秒socket超时、Claude缺用户消息投影，两项blocking统一转交实施叶第1轮红绿修复；Web旧宿主Codex诊断文案为note，不混入本轮阻塞修复。产品轴继续实际构建入口验收，最终结论尚待；不以全量检查绿代替行为验收。

- 2026-11-07：最终修复第1轮按文件预算预先分为F01审查长请求（4文件）和F02 Claude用户事件（2文件），串行实施避免同一叶超预算；仅工程拆片，不改需求。产品轴已实际复现审查后台11秒成功而前端5秒超时，保留失败证据后复核修复增量。

- 2026-11-07：产品轴阶段changes_requested，新增UF-R03：OpenCode正常stop退出0却先产生serve退出137的gap/failed并增加证据版本。转交另一实施叶F03局部修复，必须保留非主动退出和停止失败证据；F01/F02叶与F03文件不重叠并行。原scanner转实施后不自审F03，结束另派新静态叶检查修复增量。

- 2026-11-07：F01/F02/F03第1轮红绿完成，分别覆盖长审查与断连、Claude稳定用户消息/回显去重、OpenCode主动停机与真实故障。定向28项及11项通过，build退出0；新静态叶unified_delta_scanner独立增量approve、findings=[]，lint/check及19项回归通过。实际产品增量复验和主仓全量重跑仍在执行，尚不关闭U26。

- 2026-11-07：三项实际delta通过，代码两轴approve；产品仍blocked。主仓修复后全量lint/check/test退出0，388通过57配置跳过、85文件通过30跳过、189.82秒，构建退出0；Web未改动，794全链通过有效。首批24测试归属ID清理后容器/网络/worker均0。继续同一reviewer补测尚可本地执行的G0网页发送/异常恢复/故障审查，不扩大G1预算或重跑已绿分支；真实模型0调用，未发布。

- 2026-11-07：产品补测结束，无新缺陷。UE1/UE3/UE4在具名报告限定G0场景passed，UE2/UE5本机链通过但G1缺配置blocked，UE6发布blocked；三Agent实际网页发消息→终端续聊、首次401留存请求、Codex自有容器KILL恢复/缺历史不换ID不重放、无Git isolated旧固定报告不覆盖新开发均有实际证据。最终36归属ID清理后容器/网络/worker均0。综合按最差轴blocked，U26不标完成；进入rope-verify文档核对，不重启、不提交推送。
