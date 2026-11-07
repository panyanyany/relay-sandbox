# 终端直连任务、审核与进度（首轮历史）

状态：首轮执行及最终失败保留在本文件。D19/D20重新对齐后，用户已选择完整流程；生命周期修订R01–R16提纲已确认；详细任务与新矩阵见[修订任务](revision-tasks.md)，Contract Note已确认；R01实测Claude原生!命令绕过准入，R02–R16暂停，未修改产品生命周期。

## 全局约束与文件归属

- 完整合同及约束见 prd.md，确认决定见 grill-decisions.md。每片继承 C12，不能擅自改变架构或授权。
- `webcoding:` 前缀表示 Webcoding 检出目录下的相对路径，实际本机路径在 `.local/devdocs/`。其余路径相对本仓库。
- Owned files 是该片主要维护文件，未列文件不可顺手修改；新增发现需父执行者重切、检查依赖并更新归属。父执行者独占 map/tasks/review 进度元数据。
- 每片约400行差异、最多4个主要文件；源码和测试少于500行。旧大文件只做小量 import/委派装配，不新增业务逻辑，超过预算当场重切。
- 结构性前置片和组成片允许，但必须说明所属用户行为及独立完成证据；不能仅因编译通过就关闭切片。
- Red/Green 必须填实际命令、失败原因及通过结果；不把尚未运行的计划写成证据。原生能力不满足时留档并停止依赖片。

## Behavior Matrix

| ID | Given / When | Then | Applies? / Verified at |
| --- | --- | --- | --- |
| B01 | 已选 Agent 和可用环境，用户进入终端并发送消息 | 原生界面实际来自容器内 Agent，多轮上下文保持，无宿主协调调用 | yes；实际 CLI/PTY，E1–E3；逐片测试与最终真实入口审核 |
| B02 | 终端已有上下文，网页用同 ID 打开并继续，反向亦然 | 同一原生上下文、项目、环境和审查记录；不重放上一轮 | yes；共享会话入口，E1–E3；逐片测试与最终真实入口审核 |
| B03 | 本轮开发尚未结束，用户关闭终端/页面后重连 | 本轮与采集继续，完成后等输入，无新 daemon，无自动收费审查 | yes；进程与记录，E4；逐片测试与最终真实入口审核 |
| B04 | 一个入口已执行，其他入口同时发起开发 | 仅一个操作准入，其他立即 busy；无接管/排队/中断 | yes；跨进程准入，E2/E3；逐片测试与最终真实入口审核 |
| B05 | 会话空闲，用户显式 review/网页审查 | 按配置审查固定代码及运行行为，分别结论并显示/保存结构化结果 | yes；CLI/网页审查，E5；逐片测试与最终真实入口审核 |
| B06 | 会话运行中调用 review，或固定证据时新开发到达 | 忙碌立即非零错误，无审查调用，不打断；不能检查后竞态写入 | yes；操作互斥，E5；逐片测试与最终真实入口审核 |
| B07 | 审查接口超时/鉴权失败/无效结果，之后用户补审 | 明确未完成，可退出；成果证据保留；补审原版本不重跑开发 | yes；错误与版本事实，E5/E6；逐片测试与最终真实入口审核 |
| B08 | 会话异常中断/审查后又开发/旧版本补审 | 再进入提醒待审；新工作重新待审，旧结果不覆盖新状态 | yes；恢复与报告，E4–E6；逐片测试与最终真实入口审核 |
| B09 | direct/isolated、非Git项目、关闭审核或配置多个Agent | 继承访问及交付配置；开发与审查凭据隔离；缺配置明确报错 | yes；配置/资源边界，E5/E7；逐片测试与最终真实入口审核 |
| B10 | 旧宿主线程、旧review --file、MCP委派或其他网页Agent | 不误认沙箱线程，不误路由、不丢历史、不改变旧业务行为 | yes；旧入口真实调用，E7；逐片测试与最终真实入口审核 |
| B11 | Agent提供实际增量/只提供完整消息/重连读取游标 | 有增量及时展示，无增量不造假；重放去重，缺口可见 | yes；实际事件来源，E1–E3；逐片测试与最终真实入口审核 |
| B12 | 空输入、缺少/非法ID、路径越界、缺配置、原生ID未产生或依赖未就绪 | 明确拒绝或说明初始化，不误报已执行、已恢复或已通过；不泄露凭据 | yes；单元/CLI边界测试、最终入口审核 |
| B13 | 请求重复、游标重复、并发收尾或重连 | 不重复启动开发/采集，不自动重放副作用；重复的独立review可生成新尝试但不能并发写同一证据 | yes；准入、事件重放和版本测试 |

## 切片明细

### S01：验证三个 Agent 的会话与交互能力
- Status：completed（前置能力；产品E1另验）
- Kind：contract
- Goal / Public behavior：证明同一原生上下文可从 TUI/结构化模式恢复，核对忙碌信号、退出、真实增量；不能满足则回到需求对齐，不伪装已支持。
- Blocked by：none
- Owned files：`scripts/probe-native-sessions.ts`；`tests/unit/native-session-probe.test.ts`；`.rope/issues/direct-terminal/capabilities.md`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B03、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C02, C04, C10, C13, C12；决定来源 D1、D11、D12、D15、D17、D18。
- Required evidence / Tests：探针单元测试先失败；实际CLI能力逐项记录来源、版本和通过/不支持/未知，真实费用遵守G1。
- Verification：Red：探针模块缺失；Green：2项探针测试与真实CLI合成证据通过，主仓196通过57跳过；约束证据：capabilities.md（完整产品E1待验）。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S02：共享会话身份与旧记录识别
- Status：completed
- Kind：contract
- Goal / Public behavior：同 ID 绑定同项目、环境、Agent 原生身份；旧宿主线程明确识别，不能误续接。
- Blocked by：S01
- Owned files：`src/sessions/schema.ts`；`src/terminal/session.ts`；`tests/unit/session-store.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B02、B10；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C02, C08, C09, C12；决定来源 D15、D17。
- Required evidence / Tests：`tests/unit/session-store.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失创建/绑定API；Green：5新+4旧测试、eslint/check通过；约束证据：tests/unit/session-store.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S03：开发与审查共用互斥状态
- Status：completed
- Kind：contract
- Goal / Public behavior：同会话一次只准一个操作；忙碌立即拒绝，失败释放或显式遗留故障，不记录客户端控制权。
- Blocked by：S02
- Owned files：`src/sessions/operation.ts`；`src/sessions/state.ts`；`tests/unit/session-operation.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B04、B06；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C03, C13, C12；决定来源 D14、D16。
- Required evidence / Tests：`tests/unit/session-operation.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失operation模块；Green：5项测试、eslint/check通过；约束证据：tests/unit/session-operation.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S04：公共事件与有界重放
- Status：completed
- Kind：contract
- Goal / Public behavior：两入口读同一事件源；支持增量及时转发、重连去重、截断与证据缺口可见。
- Blocked by：S02
- Owned files：`src/sessions/events.ts`；`src/sessions/event-store.ts`；`src/agents/sessions/contract.ts`；`tests/unit/session-events.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C02, C10, C12；决定来源 D12、D15、D17、D18。
- Required evidence / Tests：`tests/unit/session-events.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失event-store模块；Green：6项测试、eslint/check通过；约束证据：tests/unit/session-events.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S05：会话绑定既有持久环境
- Status：completed
- Kind：vertical
- Goal / Public behavior：从已有项目配置取得沙箱环境，保留 direct/isolated 和开发凭据隔离，不创建第二套生命周期。
- Blocked by：S03
- Owned files：`src/sessions/environment.ts`；`src/sessions/profile.ts`；`src/terminal/session.ts`（受控task绑定）；`tests/unit/session-environment.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B09；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C08, C11, C12；决定来源 D1、D7、D15、D17。
- Required evidence / Tests：`tests/unit/session-environment.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失环境模块；Green：6新+5会话测试、eslint/check通过；约束证据：tests/unit/session-environment.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S06：任务自有后台执行与重连（S06a/S06b）
- Status：completed（S06c装配修复）
- Kind：vertical
- Goal / Public behavior：开发进程独立于前端连接存活，日志落盘；不注册守护服务，进程故障明确中断。
- 工程子片：S06a worker/API准入及断连（worker.ts、worker-api.ts、socket回归，约340行）；S06b dispatch启动归属、竞争与超时（dispatch.ts、启动回归，约120行）；S06c真实driver必须在worker锁取得后初始化的工厂与启动deadline。单片预算分别核对，公开合同不变。
- Blocked by：S04, S05
- Owned files：`src/sessions/worker.ts`；`src/sessions/dispatch.ts`；`src/sessions/worker-api.ts`；`tests/unit/session-worker.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B03、B04；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C03, C05, C12；决定来源 D5、D8、D10、D16。
- Required evidence / Tests：`tests/unit/session-worker.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失worker模块；Green：7项真实socket/detached及锁后工厂测试、eslint通过；全局check随后通过；约束证据：tests/unit/session-worker.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S07：会话运行期审计及指标连接
- Status：completed
- Kind：vertical
- Goal / Public behavior：后台开发继续采集，重连不重复启动采集器，采集缺失如实记录，不在普通回复后触发 AI 审查。
- Blocked by：S06
- Owned files：`src/sessions/audit.ts`；`src/sessions/evidence-index.ts`；`src/audit/collector.ts`（运行中只读快照）；`tests/unit/session-audit.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B03、B05、B08；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C05, C06, C08, C11, C12；决定来源 D5、D6、D10。
- Required evidence / Tests：`tests/unit/session-audit.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失模块；Green：2项测试、eslint/check通过；约束证据：tests/unit/session-audit.test.ts（Docker产品验收另计）。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S08：原生终端传输与断开保留
- Status：completed
- Kind：vertical
- Goal / Public behavior：显示和操作原生界面，离开只断开；不从原生屏幕文本猜测结构化结果。
- Blocked by：S06
- Owned files：`src/docker/interactive.ts`；`src/sessions/transport.ts`；`src/sessions/attach.ts`；`tests/unit/session-transport.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B03；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C04, C05, C13, C12；决定来源 D8、D10、D11。
- Required evidence / Tests：`tests/unit/session-transport.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失模块；Green：5项测试、eslint/check通过；约束证据：tests/unit/session-transport.test.ts（Docker产品验收另计）。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S09：Codex 原生会话适配
- Status：blocked（最终实际冷原生失败）
- Kind：vertical
- Goal / Public behavior：原生身份发现、恢复、结构化消息、忙碌结束信号共用同一会话，优先真实 delta。
- Blocked by：S01, S04, S08
- Owned files：`src/agents/sessions/codex.ts`；`codex-gateway.ts`；`codex-driver.ts`（同目录）；`tests/unit/session-codex.test.ts`；`tests/e2e/direct-codex.test.ts`。工程子片S09a协议/准入、S09b实际Docker driver，每片最多4主文件及约400行。
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C02, C04, C10, C12；决定来源 D1、D11、D15、D17、D18。
- Required evidence / Tests：`tests/unit/session-codex.test.ts`、`tests/e2e/direct-codex.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失Codex适配模块；Green：2项真实Unix WebSocket/假JSONL上游测试、eslint通过，类型无本片错误；最终实际冷线程失败，NATIVE-E2E-002两轮后升级，见review.md/E1。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S10：Claude Code 原生会话适配
- Status：completed
- Kind：vertical
- Goal / Public behavior：与 S09 同一公共契约，保留 Claude 原生历史与参数，不复制 Codex 专属逻辑。
- Blocked by：S01, S04, S08
- Owned files：`src/agents/sessions/claude-code.ts`；`claude-bridge.ts`；`claude-driver.ts`（同目录）；`tests/unit/session-claude.test.ts`；`tests/e2e/direct-claude.test.ts`。工程子片S10a协议/原子hook、S10b容器driver，每片最多4主文件及约400行。
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C02, C04, C10, C12；决定来源 D1、D11、D15、D17、D18。
- Required evidence / Tests：`tests/unit/session-claude.test.ts`、`tests/e2e/direct-claude.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失Claude模块与空TUI提前绑定；Green：修复轮1后6项测试、eslint/check通过，含真实Node hook/socket/stdio往返；真实Docker产品验收pending。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S11：OpenCode 原生会话适配
- Status：completed
- Kind：vertical
- Goal / Public behavior：保留已有开发 Agent 选择，完成原生恢复和统一事件；已知能力限制明确记录。
- Blocked by：S01, S04, S08
- Owned files：`src/agents/sessions/opencode.ts`；`opencode-bridge.ts`；`opencode-driver.ts`（同目录）；`tests/unit/session-opencode.test.ts`；`tests/e2e/direct-opencode.test.ts`。工程子片S11a HTTP准入桥、S11b容器driver，每片最多4主文件及约400行。
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C02, C04, C10, C12；决定来源 D1、D11、D15、D17、D18。
- Required evidence / Tests：`tests/unit/session-opencode.test.ts`、`tests/e2e/direct-opencode.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失适配器；Green：3项HTTP/stdio代理回归、eslint/check通过。普通message支持，async/command/shell显式拒绝；Docker验收pending。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S12：原生终端会话控制器
- Status：completed
- Kind：vertical
- Goal / Public behavior：按共享 ID 打开开发 Agent，离开保留本轮，busy 依据真实执行状态，等待输入不等于忙碌。
- Blocked by：S07, S09, S10, S11
- Owned files：`src/terminal/command.ts`（S17装配）；`src/sessions/native-channel.ts`；`src/terminal/native-input.ts`；`tests/unit/terminal-native.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B03；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C03, C04, C05, C13, C12；决定来源 D1、D8、D11、D15。
- Required evidence / Tests：`tests/unit/terminal-native.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失原生通道；Green：4项真实私有socket/断连/尺寸/预算测试、eslint通过；已按服务/终端两子片实施，444行。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S13：统一 JSON 会话操作入口
- Status：completed
- Kind：vertical
- Goal / Public behavior：网页可通过 CLI 向相同原生会话发消息和读进度，不额外启动宿主协调 AI。
- Blocked by：S07, S09, S10, S11
- Owned files：`src/sessions/json-command.ts`；`src/sessions/json-protocol.ts`；`tests/unit/session-json-cli.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B02、B03、B04、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C02, C03, C10, C12；决定来源 D12、D15、D16、D17、D18。
- Required evidence / Tests：`tests/unit/session-json-cli.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失统一JSON入口；Green：3项身份/游标/忙碌/断开回归、eslint通过；真实入口由S17装配。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S14：固定本次审查证据
- Status：completed
- Kind：vertical
- 工程子片：S14a冻结与快照实现（约264行）；S14b失败与模式回归（约203行）。每片约400行上限，避免删注释压缩。
- Goal / Public behavior：仅空闲会话准入，固定代码与日志版本；冻结阶段禁止新开发进入，候选与审计摘要可核对。
- Blocked by：S03, S07
- Owned files：`src/sessions/review/evidence.ts`；`src/sessions/review/snapshot.ts`；`tests/unit/session-review-evidence.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B05、B06、B08；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C03, C06, C07, C11, C13, C12；决定来源 D3、D6、D9、D14。
- Required evidence / Tests：`tests/unit/session-review-evidence.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失证据模块；Green：7项回归与eslint通过；全量check待并行适配片修复类型错误后复核。约束证据：tests/unit/session-review-evidence.test.ts。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S15：宿主独立审查执行器
- Status：completed
- Kind：vertical
- Goal / Public behavior：按配置独立审查代码与行为，不把审查凭据给开发 Agent；超时、鉴权和无效输出明确失败。
- Blocked by：S14
- Owned files：`src/sessions/review/executor.ts`；`config.ts`；`cli.ts`（同目录）；`tests/unit/session-review-executor.test.ts`；`tests/unit/session-review-cli.test.ts`。工程子片S15a配置/严格结果、S15b真实只读CLI执行，每片最多4主文件及约400行。
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B05、B07、B09；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C06, C07, C08, C11, C13, C12；决定来源 D3、D4、D6。
- Required evidence / Tests：`tests/unit/session-review-executor.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失执行器；Green：7项定向测试、全局lint/check通过；实际CLI隔离启动已验证，真实模型尚未调用。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S16：报告与待审版本管理
- Status：completed
- Kind：vertical
- Goal / Public behavior：旧报告保留，失败可补审；后续工作重新待审，旧证据补审不覆盖新工作。
- Blocked by：S15
- Owned files：`src/sessions/review/report.ts`；`src/sessions/review/state.ts`；`tests/unit/session-review-report.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B05、B07、B08；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C06, C07, C11, C12；决定来源 D4、D5、D9。
- Required evidence / Tests：`tests/unit/session-review-report.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：Red：缺失固定证据补审；Green：S15/S16定向10项、全局lint通过；按固定材料历史/编排通知拆a/b，约520行。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S17：正式 CLI 路由及旧命令兼容
- Status：completed
- Kind：vertical
- Goal / Public behavior：默认进入原生终端；review 会话自动审查，旧 review 任务 --file 继续提交结构化审核，错误对象不误路由。
- Blocked by：S12, S13, S16
- 工程子片：S17a运行时工厂、S17b控制RPC、S17c隔离checks、S17d命令与终端前端；每片约400行及最多4主文件。
- Owned files：`src/sessions/runtime.ts`；`runtime-driver.ts`；`review/checks.ts`；`src/terminal/frontend.ts`（对应子片）；`src/cli/main.ts`；`src/cli/session-commands.ts`；`src/cli/review-command.ts`；`tests/unit/terminal-cli.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01、B02、B05、B06、B10；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C06, C09, C12；决定来源 D7、D13、D14、D17。
- Required evidence / Tests：`tests/unit/terminal-cli.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：锁后runtime、控制RPC、独立checks和CLI已装配；多项真实临时socket/子进程/假worker回归通过，完整产品验收另计。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S18：Webcoding 共享会话接入
- Status：completed
- Kind：vertical
- Goal / Public behavior：网页打开统一会话 ID，恢复共享上下文和事件，无独立网页模型调用；保持其他 Agent 不变。
- Blocked by：S13, S17
- Owned files：`webcoding:srv/relay-runtime.ts`；`webcoding:srv/relay-session-link.ts`；`webcoding:scripts/tests/relay-runtime.test.ts`；`webcoding:scripts/tests/relay-session-link.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B02、B03、B04、B10、B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C02, C03, C04, C08, C09, C10, C12；决定来源 D7、D12、D15、D16、D17。
- Required evidence / Tests：`webcoding:scripts/tests/relay-runtime.test.ts`、`webcoding:scripts/tests/relay-session-link.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：5项Webcoding定向和双类型检查通过；v2映射/真实事件/持久游标；终端用户消息补入S19继续。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S19：Webcoding 审查操作后端
- Status：completed
- Kind：vertical
- Goal / Public behavior：显式操作调用同一会话审查控制层，busy 拒绝与结果错误可在网页观察。
- Blocked by：S16, S18
- Owned files：`webcoding:srv/relay-session-actions.ts`；`webcoding:srv/ws-dispatch.ts`；`webcoding:server.ts`；`webcoding:scripts/tests/relay-session-actions.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B05、B06、B07；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C03, C06, C08, C12；决定来源 D7、D12、D13、D14。
- Required evidence / Tests：`webcoding:scripts/tests/relay-session-actions.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：认证动作、跨入口历史与传统停止19项回归及Web双类型检查通过；无ID消息分轮回归通过。S19b额外归属relay-session-history.ts/runtime及history测试；S19c归属process-runtime-controls.ts及测试。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S20：Webcoding 审查与待审界面
- Status：completed
- Kind：vertical
- Goal / Public behavior：显示审查入口、未审/失败/完成及历史报告，不把开发回复当作审查结果。
- Blocked by：S19
- Owned files：`webcoding:src/ui/relay-session-controls.ts`；`webcoding:src/ws/relay-events.ts`；`webcoding:src/ws/handlers.ts`；`webcoding:scripts/tests/relay-session-controls.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B05、B07、B08；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C04, C06, C07, C12；决定来源 D7、D9、D12。
- Required evidence / Tests：`webcoding:scripts/tests/relay-session-controls.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：实际工具栏菜单装配；状态、打开、审查、补审、停止3项回归及Web双类型检查通过。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S21：中断恢复、停止与并发边界贯通
- Status：blocked（受冷Codex原生历史缺失影响）
- Kind：vertical
- Goal / Public behavior：明确停止才中止当前执行，普通断开不停止；进程崩溃标记中断，重连不重放副作用。
- Blocked by：S12, S13, S16
- Owned files：`src/sessions/stop.ts`；`src/sessions/recovery.ts`；`tests/unit/session-recovery.test.ts`；`tests/integration/session-lifecycle.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B03、B04、B06、B08；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C03, C05, C07, C11, C13, C12；决定来源 D5、D8、D10、D14、D16。
- Required evidence / Tests：`tests/unit/session-recovery.test.ts`、`tests/integration/session-lifecycle.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：14项停止/恢复及状态回归、全局lint/check通过；恢复后版本待审，遗留恢复协调锁明确拒绝。最终实际stop/resume元数据成功但冷Codex新worker未就绪，见E4；不视为完整恢复通过。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S22：旧宿主终端收缩与兼容回归
- Status：completed
- Kind：wide-refactor-contract
- Goal / Public behavior：新入口不再依赖宿主协调器；旧历史保留且不假装原生开发线程，MCP 委派与旧审核回归通过。
- Blocked by：S17, S18, S20, S21
- Owned files：`src/terminal/host.ts`；`src/terminal/turn.ts`；`tests/unit/terminal.test.ts`；`tests/unit/terminal-cancellation.test.ts`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B09、B10；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C01, C09, C12；决定来源 D1、D7、D17。
- Required evidence / Tests：`tests/unit/terminal.test.ts`、`tests/unit/terminal-cancellation.test.ts`；先锁定本片公开行为及失败分支，红→绿；真实语义仍依e2e.md。
- Verification：移除旧host/turn及执行兜底，实际CLI/假worker两轮和断开5项通过；Commander全局cwd丢失已回归修复。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S23a：主仓库使用与兼容文档
- Status：completed
- Kind：vertical
- Goal / Public behavior：操作说明准确描述原生直连、统一会话、审查和已验证限制；旧宿主说明不冒充新实现。
- Blocked by：S22
- Owned files：`devdocs/terminal.md`；`devdocs/usage.md`；`README.md`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01–B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C12, C12；决定来源 D1–D18。
- Required evidence / Tests：核对真实命令与已落盘证据，检查链接和索引；不为文档改动编写镜像实现的单元测试。
- Verification：README/terminal/usage已更新新契约与验收边界。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S23b：结构、索引与验收记录
- Status：completed
- Kind：vertical
- Goal / Public behavior：结构树、索引和验证记录对应最终实现，未验证场景不标记通过。
- Blocked by：S23a
- Owned files：`devdocs/structure.md`；`devdocs/implementation-validation.md`；`AGENTS.md`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B01–B11；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C12, C12；决定来源 D1–D18。
- Required evidence / Tests：核对真实命令与已落盘证据，检查链接和索引；不为文档改动编写镜像实现的单元测试。
- Verification：结构、AGENTS索引、实现验证及真实验收终态均已记录；失败和未覆盖项保留，见review.md/e2e.md。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

### S24：网页文档及授权发布验证
- Status：blocked
- Kind：vertical
- Goal / Public behavior：两边检查构建通过，按既有本机范围发布 Webcoding，核对服务/入口/图标；不动用户项目沙箱。
- Blocked by：S23b
- Owned files：`webcoding:.devguide/relay-sandbox.md`；`webcoding:.devguide/project.md`；`webcoding:AGENTS.md`；`.local/devdocs/terminal-delivery.md`
- Size cap：约400行差异、最多4个主要文件；超过即重切；不把注释删掉规避长度。
- Matrix rows：B02、B05、B10；非法/缺失及重复边界按 B12/B13 检查。
- Constraint IDs：C12, C12；决定来源 D7、D12、D15。
- Required evidence / Tests：核对真实命令与已落盘证据，检查链接和索引；不为文档改动编写镜像实现的单元测试。
- Verification：网页文档和两仓检查已完成；发布因E1冷Codex原生入口失败、E2/E3/E5缺专用配置而blocked，见e2e.md及review.md；未重启。
- Stop conditions：合同/能力/权限冲突、预算超限、真实依赖不可用或触及非归属文件时记录并交父执行者处理；不降级伪造。

## 依赖图与执行安排

- 共25片；S23按已确认预算拆为S23a/S23b，范围不变。全部串行25单位、关键路径17单位、17个波次，仅说明依赖，不作为工期。
- 一条相连交付链；并列分支共用上游，不拆成独立issue。最宽就绪波次4片；实施阶段计划最多3个叶执行者，父执行者占第4槽，剩余就绪片排队。
- host-managed共享工作区，不自动commit/push，不创建需要HEAD已提交前提的worktree；归属文件不重叠才并发。

- 波次1：S01
- 波次2：S02
- 波次3：S03、S04
- 波次4：S05
- 波次5：S06
- 波次6：S07、S08
- 波次7：S09、S10、S11、S14
- 波次8：S12、S13、S15
- 波次9：S16
- 波次10：S17、S21
- 波次11：S18
- 波次12：S19
- 波次13：S20
- 波次14：S22
- 波次15：S23a
- 波次16：S23b
- 波次17：S24

## 审核栏

| 项目 | 状态 | 证据 / 责任 |
| --- | --- | --- |
| D1–D18需求整体确认 | confirmed | grill-decisions.md；用户已确认 |
| 切片顺序 | confirmed | slice-outline.md；用户已确认 |
| Contract Note | confirmed | 用户已确认 prd.md 五条摘要 |
| G1真实模型执行方 | approved | 用户选择AI执行；各Agent最多2轮，独立审查最多2次 |
| 原生能力前置 | passed（能力范围） | 三种实际CLI的上下文共享、原生拒绝及断连路径已有合成证据；生产集成与完整E1仍待执行 |
| G3协议代理依赖 | approved | 2026-11-07用户授权；ws8.22.1及@types/ws8.18.2已锁定安装 |
| 最终代码扫描 | passed | native_final_scan静态delta通过；CRASH-SCAN-001第二轮关闭，见review.md |
| 最终行为审核 | changes_requested | native_final_acceptance；冷Codex两轮仍失败，见review.md |
| E2E | blocked | E1/E4 failed，其余blocked；e2e.md与私有实际报告分列事实 |
| 两仓lint/check/test/build | passed | 2026-11-07主仓315通过57跳过；Web792通过；两仓lint/check/build退出0 |
| 文档与本机发布 | blocked | 文档已更新；E1失败及真实模型缺配置，S24/E8不发布 |
| verify | blocked | 冷Codex真实入口失败和专用测试配置缺失；见verify.md |

## 进度日志

| 时间 | 事项 | 结果与下一步 |
| --- | --- | --- |
| 2026-11-06 | 需求整体确认 | D1–D18已确认；进入完整流程 |
| 2026-11-06 | 切片提纲确认 | 24片顺序获确认；正式明细将文档片S23拆为a/b，符合4文件上限 |
| 2026-11-06 | 正式任务包展开 | 25片、17波次；尚未实施，等待交付摘要和G1方式确认 |


| 2026-11-06 | 开始执行 | Contract Note 与 G1 已确认；共享工作区，最多3叶并发（最宽4片，父占1槽）；generic worker（preset_missing），不自动提交。S01先验证硬合同，后续依赖片等待能力结论。 |

| 2026-11-06 | 实施前基线 | 主仓 lint/check 通过，194测试通过、57跳过；Webcoding lint 0错误（734既有警告）、两套类型检查通过。S01正以实际CLI+假中转验证，尚未使用G1付费轮次。 |

| 2026-11-06 | S01阶段证据 | Codex结构化→原生同上下文与真实TUI协议拒绝、Claude双向续接/原子拒绝/断线存活已实证。新增探针2项红绿；OpenCode继续隔离验证。Codex成熟WebSocket代理需要ws及类型依赖，G3待确认，未安装，不推进依赖该合同的后续片。 |
| 2026-11-06 | S01阶段收尾检查 | 主仓lint/check/test/build通过：196通过、57跳过。OpenCode实际同上下文与HTTP输入路径通过，busy注入未成功、断连未测；完整S01不标完成。G3待确认，未安装依赖、未改正式入口、未部署；付费模型轮次0。 |

每次推进追加实际结果；失败保留原因和脱敏证据路径。不得把待办内容改写成完成事实。

| 2026-11-07 | G3批准并续接 | 用户要求按统一控制层架构实施，ws与类型已安装；保留原有未提交成果，不自动提交。仍最多3叶并发，最宽4片因父占槽排队；S01补足OpenCode准入证据后推进下游。 |

| 2026-11-07 | S01能力补证 | OpenCode实际原生busy提交409、无模型调用或重放；TUI退出后serve继续完成。三种原生入口可实现硬合同，S02开始；生产原子锁与完整E1另验，付费轮次0。 |

| 2026-11-07 | S02完成 | V2开发会话与V1宿主线程分离，真实cwd/project/agent固定；原生及任务环境绑定不可更换。新5+旧4测试绿，eslint/check通过，3文件约299新增行。S03原子准入与S04事件并行开始。 |

| 2026-11-07 | S03完成及S05启动 | 原子随机token操作锁、进程身份、明确busy/中断及证据版本已实现；5项测试与eslint通过，check通过。S04尾检与S05无重叠文件，S05在依赖S03就绪后启动，避免等待无关片。 |

| 2026-11-07 | S04完成 | 公共语义事件与原子JSONL有界日志、单调游标/轮转gap已实现；6项红绿测试，eslint/check通过，4文件365行。原生屏幕与语义事件分开。 |

| 2026-11-07 | S05边界收敛 | 准备前需持久化task归属以保留失败诊断，新增受控bindDevelopmentTask复用metadata锁；S05扩为4文件，避免绕过S02写入约定，不改变公开行为。 |

| 2026-11-07 | S05完成 | 已注册项目匹配、会话固定任务、冻结开发档案和最小凭据环境已连接；6项新+5会话测试绿，eslint/check通过；4文件约300行。S06开始任务自有worker及断连继续。 |

| 2026-11-07 | S06工程重切及S07/S08启动 | S06a真实socket红绿通过；S06b独立完善dispatch启动归属竞争与超时，避免旧worker应答冒充本次启动成功。S07/S08仅依赖已绿core，文件不重叠，三叶并发；原生driver尚未装配，不宣称Agent产品就绪。 |

| 2026-11-07 | S07采集边界补齐 | 独立审查需要固定运行中证据，collector增加可选snapshot并保留旧接口；快照不停止采集，后续开发沿用同一采集器。S07扩为4文件，覆盖缺口继续如实上报。 |

| 2026-11-07 | S06a/b完成 | 统一准入与detached worker/PID握手通过5项合成回归，eslint/check通过；4文件约490行（已重切为两子片），尚未装配实际vendor及CLI内部入口。 |

| 2026-11-07 | S07/S08完成及适配波次 | 运行中审计快照2项测试、交互传输5项测试及eslint/check通过。S09/S10按协议准入与Docker驱动拆子片以保小文件；与S14证据冻结并行，S11因父占槽等待下一空位，不串行依赖无关片。 |

| 2026-11-07 | 原生准入信任范围与冻结 | Claude hook是原生CLI协作信号，不宣称同UID容器内防伪安全边界；真正审查写入隔离由宿主pause全任务容器承担。S14实现/回归重切a/b，保持所有文件小于500行；审查只代表固定证据时间点。 |

| 2026-11-07 | S14a/b完成、S11启动 | 7项冻结/恢复/双模式/预算回归与eslint通过；审查锁和全任务pause保持到callback结束。全量check存在并行适配片在途错误待收口。S11使用空闲槽开始；S10空TUI未落历史问题进入修复轮1。 |

| 2026-11-07 | S06c与S15工程收口 | 真实driver初始化移到worker独占锁之后，避免重复启动先产生厂商进程；增加工厂失败与ready回归。S15保持真正宿主CLI Agent含义，不用HTTP调用冒充Codex/OpenCode；配置/结果与只读CLI拆子片，严格隔离review凭据。 |

| 2026-11-07 | S09/S10完成 | Codex同thread WebSocket/stdio网关、真实delta及迟到事件防误释放；Claude实际broker与空TUI修复轮1通过。两片仅协议/合成装配验证，不冒充真实Docker或付费模型E2E。 |

| 2026-11-07 | 统一入口装配 | S12/S13/S15/S16/S18模块回归通过；CLI开始切换真实开发会话。S05新增先返回授权UUID再准备，S03允许中断固定材料补审且保留中断；新增回归先红后绿。S21停止恢复与S19认证网页动作并行；付费调用仍0，未发布。 |

| 2026-11-07 | 停止恢复及旧入口收口 | S21及S22定向通过；实际CLI回归发现并修复Commander全局cwd丢失。S17复用原候选检查管线，不在开发容器运行检查。固定检查事实和后台失败status补充红绿回归；S19/S20并行实施，完整验收与发布pending。 |

| 2026-11-07 | 网页接入冻结 | S19/S20定向22项与Web类型检查通过；Claude/恢复16项通过。全量两仓检查及两名全新只读最终审核并行开始；scanner静态，reviewer独占产品验收，不动生产资源，真实模型仍0调用。 |

| 2026-11-07 | 最终审核第一轮修复 | SEC1/WEB1/WEB2及实际冻结摘要问题已定向红绿修复，S20装配回归18项通过；Codex首次原生空线程恢复修复中。全量测试与真实入口复核尚未完成，未发布。 |

| 2026-11-07 | 实际入口故障注入 | Docker真实busy/断连继续、同原生上下文及独立审查暂停已取证；非法JSON/401/timeout固定证据补审均未完成且保留。冷Codex历史分页fix round 2、Docker Tty参数和审查stdout诊断并行修复；终端旧V1错误已收敛。主仓300通过57跳过但旧后台派发10秒期限失败，须继续定位，未发布。 |

| 2026-11-07 | 中断状态与恢复闭环 | CRASH-E2E-006第一轮统一Docker wait和三Agent后端故障传播；scanner识别CRASH-SCAN-001后第二轮收敛故障停止。先确认全部写入者停止再归还自身租约，保留清理错误与死亡核查；定向红绿通过，最终全量及真实delta进行中。Web最终792项通过，尚未发布。 |

| 2026-11-07 | 最终冻结检查通过 | 主仓lint/check/test/build退出0，315通过57跳过；Web792通过及构建成功。最终scanner通过，实际reviewer使用同一dist执行剩余delta；真实模型缺专用配置，未发布、未提交。 |

| 2026-11-07 | 最终实际裁定与升级 | 原生冷Codex条目分页两轮仍失败，冷恢复worker不就绪；E1/E4 failed，其余blocked。TTY/旧V1/401/137留证通过，18个归属资源清理后容器0网络0。综合changes_requested，不发布、不提交，进入verify阻塞收尾。 |

当前统一输入执行包见[统一输入任务](unified-input-tasks.md)；本文件只保留首轮计划与实际证据，不按旧原生TUI目标继续执行。
