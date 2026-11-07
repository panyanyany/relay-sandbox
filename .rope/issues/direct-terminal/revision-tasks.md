# 原生生命周期修订任务、审核与进度（历史）

状态：D21–D25已改为统一输入，U提纲待确认；R02–R16不再按原生TUI方向执行，原R01失败与下列计划保留历史。R01–R16提纲曾确认；详细合同已由用户选择1确认，进入rope-go；R01能力验证就绪，其余按依赖推进。首轮S任务及失败在tasks.md/e2e.md保留。

## 接手顺序与文件结构

先读prd.md的生命周期修订合同、grill-decisions.md D19/D20、map.md，再按下表执行；不重新探索无关项目。src/terminal负责入口/正式记录；src/sessions负责生命周期、环境、准入和审计；src/agents/sessions负责各Agent实际协议；Webcoding的srv负责已认证CLI接入，scripts/tests为回归入口。

webcoding:表示关联检出目录；本机路径见.local/devdocs/index.md。startup-context、activation、first-request、codex-rpc、startup-close、readiness及对应测试为计划新增，不表示已存在。其余路径须开工时核对基线。

## 全局执行规范

- 继承PRD C01–C16；中文注释覆盖函数、关键状态顺序及修复错误示范，解释为何不能先执行后落盘、先杀后判定、容器就绪冒充Agent就绪。
- 每片约400行差异、最多4主要文件，源码/测试少于500行；超过即重切，不把新逻辑继续塞进大文件。同波次allowlist不重叠，父串行维护本包、map、review和证据索引。
- 仅修改allowlist；遇到跨界必要修改，先收敛边界/补子片再动手。R02扩展接口、R08迁移调用、后续删除旧绕行，确保中间阶段可检查，不同时制造两个正式身份来源。
- 每片先失败测试再实现，记录红/绿实际命令及输出摘要；必要测试清理用finally，保留堆栈和阶段。编译通过不等于行为通过。
- 优先复用既有原子锁/文件存储/派发及成熟Agent协议，不增加Redis、数据库约束、依赖或专用daemon。
- 每片相关测试；最终两仓pnpm lint、pnpm check、pnpm test、pnpm build。完成更新devdocs；真实验收不通过不发布，不自动commit/push。

## Behavior Matrix（与首轮B01–B13合并审核）

| ID | Given / When | Then | 验证 |
| --- | --- | --- | --- |
| B14 | 无原生历史的新启动进入终端 | 正常创建至可输入，无预热/预建后强制resume | 协议测试及RE1真实CLI |
| B15 | 新启动仅看菜单/写未提交草稿后离开 | 无正式记录；专用进程结束，环境/软件和必要日志保留 | 关闭测试及RE1 |
| B16 | 首次有效开发请求通过准入 | 先可靠保存正式身份与请求再执行；保存失败执行0次；首轮失败仍保留会话 | 故障注入及RE2 |
| B17 | 首准入/离开/双入口/重复通知竞争 | 唯一激活或确定关闭；不误杀已接受工作、不重放 | 屏障测试及RE2 |
| B18 | 正式会话中断后恢复 | Agent可用才成功；失败非零并保留同身份、原生历史和阶段错误 | 故障注入及RE3 |

无空输入激活、草稿激活或客户端归属锁；原生命令/工具也属于开发入口。原有B01–B13全部仍适用，不以本轮聚焦为由豁免旧验收缺口。

## 切片清单

### R01：实际生命周期补证

- Status：blocked（实际Claude原生!命令绕过现有准入；证据已归档）；Kind：vertical / 组成片。
- Blocked by：无；Matrix：B14/B15/B18；Constraints：C12、C02/C04/C14/C16。
- Owned files：`scripts/probe-native-lifecycle.ts`；`tests/unit/native-lifecycle-probe.test.ts`；`.rope/issues/direct-terminal/capabilities.md`。
- Goal / Public behavior：普通新建至输入就绪；三个Agent各记录首次可执行信号、原生落盘条件与空退出资源；无模型预热。
- Required evidence / Tests：真实CLI与假接口计数、退出码及私有证据；不能可靠阻止首次执行则停止。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R02：启动资源与正式会话分离

- Status：pending；Kind：contract / expand。
- Blocked by：R01；Matrix：B15/B16；Constraints：C12、C08/C11/C12/C14。
- Owned files：`src/sessions/startup-context.ts`；`src/sessions/environment.ts`；`src/agents/sessions/contract.ts`；`tests/unit/session-startup-context.test.ts`。
- Goal / Public behavior：新增可组合启动上下文与环境准备接口；旧正式调用保持可用，不批量迁移。
- Required evidence / Tests：准备环境无需正式记录；已有环境复用、失败诊断及凭据隔离。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R03：首次开发原子激活

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R02；Matrix：B16/B17；Constraints：C12、C02/C03/C14。
- Owned files：`src/terminal/session.ts`；`src/sessions/activation.ts`；`src/sessions/first-request.ts`；`tests/unit/session-activation.test.ts`。
- Goal / Public behavior：请求获准时先保存正式身份/请求状态；一次绑定，未持久化禁止执行。
- Required evidence / Tests：注入写失败后发送0次；双准入只成功一次；执行失败仍留正式记录。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R04：Codex协议局部提取

- Status：pending；Kind：prefactor。
- Blocked by：R02；Matrix：B14/B18；Constraints：C12、C02/C04/C12。
- Owned files：`src/agents/sessions/codex-gateway.ts`；`src/agents/sessions/codex-rpc.ts`；`tests/unit/codex-rpc.test.ts`。
- Goal / Public behavior：提取RPC关联/断开错误边界，为正常创建腾出小模块，不改变公开行为。
- Required evidence / Tests：现有协议回归；断开保留错误；网关小于500行。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R05：Codex正常首次创建

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R03/R04；Matrix：B14/B16/B18；Constraints：C12、C01/C02/C13/C14/C16。
- Owned files：`src/agents/sessions/codex-gateway.ts`；`src/agents/sessions/codex-driver.ts`；`src/agents/sessions/codex.ts`；`tests/unit/codex-lifecycle.test.ts`。
- Goal / Public behavior：新进入沿原生普通创建，真实ID按信号关联；已有历史真实恢复，移除pristine伪历史。
- Required evidence / Tests：冷入口真实复验；工具入口也先激活；无空线程预建强行resume或伪造分页。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R06：Claude首次开发激活

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R03；Matrix：B14–B17；Constraints：C12、C02/C04/C14/C15。
- Owned files：`src/agents/sessions/claude-driver.ts`；`src/agents/sessions/claude-bridge.ts`；`src/agents/sessions/claude-code.ts`；`tests/unit/claude-lifecycle.test.ts`。
- Goal / Public behavior：沿Claude实际hook/协议在执行前激活；空打开无正式记录；已有原生身份不变。
- Required evidence / Tests：真实信号补证与单测；命令/工具不绕过准入，失联失败关闭入口。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R07：OpenCode首次开发激活

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R03；Matrix：B14–B17；Constraints：C12、C02/C04/C14/C15。
- Owned files：`src/agents/sessions/opencode-driver.ts`；`src/agents/sessions/opencode-bridge.ts`；`src/agents/sessions/opencode.ts`；`tests/unit/opencode-lifecycle.test.ts`。
- Goal / Public behavior：服务启动与开发准入分开；正式身份按真实首次执行绑定。
- Required evidence / Tests：空启动、首次请求与错误信号；不套用Codex原生协议。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R08：worker与审计迁移

- Status：pending；Kind：migrate。
- Blocked by：R05/R06/R07；Matrix：B14/B16/B17；Constraints：C12、C03/C08/C11/C13/C14。
- Owned files：`src/sessions/runtime.ts`；`src/sessions/worker.ts`；`src/sessions/runtime-driver.ts`；`tests/unit/session-startup-runtime.test.ts`。
- Goal / Public behavior：装配启动上下文/三适配器/首次激活；审计先于可执行行为，失败可关联。
- Required evidence / Tests：未正式激活也留必要诊断；审计缺口可见；开发侧无审查密钥。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R09：空启动关闭及提交竞争

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R08；Matrix：B15/B17；Constraints：C12、C03/C05/C14/C15。
- Owned files：`src/sessions/worker.ts`；`src/sessions/native-channel.ts`；`src/sessions/startup-close.ts`；`tests/unit/session-startup-close.test.ts`。
- Goal / Public behavior：原子裁决关闭/准入；只关闭确认专用未开发进程；不删环境。
- Required evidence / Tests：屏障覆盖两种顺序、双断开及归属不明；已接受请求不误杀。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R10：原生CLI接入

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R09；Matrix：B14–B17；Constraints：C12、C04/C05/C14/C15。
- Owned files：`src/terminal/command.ts`；`src/terminal/frontend.ts`；`src/terminal/native-input.ts`；`tests/unit/terminal-startup.test.ts`。
- Goal / Public behavior：新启动原生可用后输入，正式ID按激活展示；现有正式会话断开保持。
- Required evidence / Tests：空退出无正式记录、已提交离开继续、原生中文及控制键透传。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R11：JSON首次请求与错误回执

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R08；Matrix：B16/B17；Constraints：C12、C02/C03/C08/C14。
- Owned files：`src/sessions/json-command.ts`；`src/sessions/json-protocol.ts`；`tests/unit/session-json-startup.test.ts`；`tests/unit/session-json-protocol.test.ts`。
- Goal / Public behavior：首个有效请求得到可靠正式ID；持久化/启动失败回执明确，不另建模型通道。
- Required evidence / Tests：写失败不发送、EOF后已接收请求继续；无虚假正式ID事件。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R12：恢复等待真实就绪

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R09；Matrix：B18/B08；Constraints：C12、C02/C05/C07/C16。
- Owned files：`src/sessions/recovery.ts`；`src/cli/session-commands.ts`；`src/sessions/readiness.ts`；`tests/unit/session-recovery.test.ts`。
- Goal / Public behavior：恢复等待真实Agent可用；超时/历史缺失明确非零，状态与错误链一致。
- Required evidence / Tests：容器running但Agent失败不得成功；同原生身份，模型请求0次，无自动重放。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R13：网页绑定正式身份

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R10/R11/R12；Matrix：B02/B10/B15–B18；Constraints：C12、C01/C02/C09/C14/C15/C16。
- Owned files：`webcoding:srv/relay-runtime.ts`；`webcoding:srv/relay-session-link.ts`；`webcoding:scripts/tests/relay-runtime.test.ts`；`webcoding:scripts/tests/relay-session-link.test.ts`。
- Goal / Public behavior：空网页草稿不创建relay正式条目；首提交绑定正式ID，错误与恢复如实展示。
- Required evidence / Tests：既有认证/跨项目拒绝、终端网页同历史、其他Agent不改；需改第五文件则重切。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R14：主仓操作文档

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R13；Matrix：B14–B18；Constraints：C12、C12/C14/C15/C16。
- Owned files：`README.md`；`devdocs/terminal.md`；`devdocs/usage.md`；`devdocs/persistent-environments.md`。
- Goal / Public behavior：记录当前可验证操作与限制，覆盖空退出、首次失败、恢复就绪。
- Required evidence / Tests：命令/语义与实际入口核对，未验收不称可用。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R15：索引结构与验证记录

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R14；Matrix：B01–B18；Constraints：C12、C12。
- Owned files：`AGENTS.md`；`devdocs/structure.md`；`devdocs/implementation-validation.md`；`.local/devdocs/terminal-delivery.md`。
- Goal / Public behavior：更新devdocs功能记录、结构与发布事实；父执行者串行维护issue元数据。
- Required evidence / Tests：逐项对应证据；旧失败保留，缺配置不称通过。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

### R16：网页文档与授权发布

- Status：pending；Kind：vertical / 组成片。
- Blocked by：R15；Matrix：B02/B10/B14–B18；Constraints：C12、C09/C12/C14/C15/C16。
- Owned files：`webcoding:.devguide/relay-sandbox.md`；`webcoding:.devguide/project.md`；`webcoding:AGENTS.md`；`.local/devdocs/terminal-delivery.md`。
- Goal / Public behavior：两仓检查/真实验收过关后复用既有发布流程，验证入口与HTTP。
- Required evidence / Tests：E8/RE4；只展示必要启动字段，不输出完整环境，不重复计划重启。
- Verification：先锁定上述失败路径再实现，运行相关测试与类型检查；真实语义见e2e.md，未运行不填写passed。
- Stop conditions：超400行/4文件、信号无法可靠准入、需新依赖/权限或实际行为违约时停止并重切/报告，不静默降级。

## 依赖波次与执行方式

16片，全部串行16单位，最长依赖链11单位，共11波次；只有一个相连交付链，无独立river。顺序已确认：1 R01；2 R02；3 R03/R04；4 R05/R06/R07；5 R08；6 R09/R11；7 R10/R12；8 R13；9 R14；10 R15；11 R16。数字不是工期。

host-managed；按rope-go及实际资源决定是否使用不重叠叶执行者，最多3叶加父；不因图存在并行分支自动扩大授权。新子片必须更新依赖与文件归属后再派发。最终按真实入口审核、代码扫描、verify执行；旧verify BLOCKED在证据补齐前保留。

## 审核栏

| 范围 | 状态 | 审核结论与证据 | 后续动作 |
| --- | --- | --- | --- |
| 修订提纲 | 用户已确认 | 2026-11-07用户选择1 | 展开包 |
| 修订Contract Note | 用户已确认 | 2026-11-07用户选择1 | 按波次执行 |
| R01–R16实现 | pending | 未执行 | 合同确认后推进 |
| 代码与行为最终审核 | pending | 首轮changes_requested另存 | 逐行为审查，不抹旧失败 |
| E2E/发布 | blocked | 旧冷入口失败、G1缺配置 | 分项补证，不标整体通过 |

## 进度日志

- 2026-11-07：用户确认D19/D20、完整流程及R01–R16提纲；展开详细包。仅修改文档，未开始修订代码、调用模型、操作容器或重启。

后续每片追加日期、ID、状态、实际修改文件、红/绿命令结果、证据路径、风险/阻塞及下一步；失败也要记录，禁止只写“已完成”。

- 2026-11-07：用户确认修订Contract Note。host-managed保留已登记的前轮未提交候选变更；最大并行3，当前就绪1，仅派发R01。基线检查开始，不自动提交推送。

- 2026-11-07 R01：真实Claude Code 2.1.263原生!命令已在隔离合成项目写入marker；拒绝UserPromptSubmit及PreToolUse均未触发。各探针仅访问本机假接口，无远程模型。C14首次执行前可靠激活尚不可满足，按R01停止条件暂停R02–R16，不新增键盘猜测拦截或降低需求。详细复现见capabilities.md及私有lifecycle-r01证据。

- 2026-11-07 R01收尾：实施执行者/root/lifecycle_r01返回design defect。新增复现脚本107行、证据分类测试36行，capabilities补记录；定向测试先红（模块缺失）后2绿；真实多钩子实验marker=true/hooks=[]，4次本机假/messages，无远程调用，进程/临时目录清理确认。基线pnpm lint/check/test通过（315通过57跳过）；新增后lint/check/build通过。未开始R02–R16，无产品修复完成声明、无发布/重启、无commit/push。preset_missing：使用默认通用实施执行者，无模型覆盖。
