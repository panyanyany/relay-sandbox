# 终端直连最终审核

## 2026-11-07 第一轮

模式为host-managed共享工作目录。用户未授权提交或推送，所有改动保持工作区。

- Scanner：`/root/native_final_scan`。主仓及Webcoding lint/check通过；新增主仓模块少于500行。仅静态检查，未运行产品。
- Reviewer：`/root/native_final_acceptance`。真实构建CLI及测试自有Docker/假中转验收进行中；无生产资源或真实模型调用。
- 当前综合结论：changes_requested。静态三项阻塞；行为审核发现冻结摘要不一致，修复中。不得作为发布通过。

| ID | 问题 | 最小修复 | 状态 |
| --- | --- | --- | --- |
| SEC1 | worker的submit context.emit可绕过开发凭据脱敏 | 在统一事件写入入口脱敏并加回显回归 | scanner delta通过 |
| WEB1 | 只读打开终端会话仅导入用户历史，遗漏助手 | 复用助手投影只读导入，稳定ID及游标去重 | scanner fix round 2通过 |
| WEB2 | 网页停止15秒超时短于后台停止窗口 | 统一180秒并加参数回归 | scanner delta通过 |
| REV-E2E-001 | 实际准备使用project+policy冻结摘要，报告却要求等于project单独摘要，导致所有实际审查未完成 | 复用冻结摘要计算与只读冻结policy验证，并锁定真实freeze路径回归 | fix round 1实际delta通过 |

真实模型E2/E3/E5需要专用测试配置。不得借用生产项目凭据或用假接口通过代替。

- NATIVE-E2E-002：真实Codex全新空线程尚无rollout，原生resume启动即失败。正在fix round 1；必须复用同一已加载线程，不能另开上下文或伪造首轮。
- 全量Web回归识别S20在无toolbar的轻量DOM中无条件创建按钮；限定修复组件挂载边界，保留旧业务测试。

NATIVE-E2E-002已实现同一空thread的初始化结果复用，首个执行前失效缓存；3项socket回归、lint/check通过，真实入口复核进行中。S20挂载修复18项和check通过。

- NATIVE-E2E-002实际delta仍失败：首次resume已修，但空线程history分页仍向无rollout请求，进入fix round 2。
- REV-E2E-003旧V1入口诊断复用已修，14项环境/存储测试、lint/check通过；历史字节保持。
- REV-E2E-004独立Codex审查错误在stdout JSONL，现仅stderr导致401原因丢失；待最小诊断提取。
- NATIVE-E2E-005真实Docker TTY屏幕出现multiplex帧头；需要exec.start同步Tty参数，沿用Docker原生能力。
- WEB1第二轮复核要求只读和live活动entry单写者；活动期间只读观察不另行导入消息，避免delta与complete互相抢投影。

## 第一轮静态终态与实际验收进展

`/root/native_final_scan` 2026-11-07最终delta：SEC1、WEB1、WEB2通过。WEB1两轮局部修复，最终采用活动入口独占语义投影，空闲只读导入；没有客户端接管锁。UI显式页面装配、CLI按命令懒加载及错误诊断delta未发现新阻塞。

`/root/native_final_acceptance`首轮实际验收：三Agent真实CLI连接本机假中转，结构化→原生→结构化上下文连续；Codex并发busy/断连存活/显式停止；独立审查真实暂停、非法JSON/401/timeout固定补审；旧review --file、真实stdio MCP准备与报告、隔离Web认证及共享ID历史均已有证据。真实模型E2/E3/E5缺专用配置，仍blocked。

本轮14个唯一task/environment归属资源已核对清理，测试容器、网络、进程剩余0。证据位于忽略目录 `.local/evidence/direct-terminal/final/`，不可将假中转通过写为真实模型通过。

剩余实际delta：冷Codex空history、TTY帧头、旧V1诊断、审查stdout原因、空闲容器崩溃可观测性。最后一项通过Docker wait共享生命周期修复中。未发布、未提交。

## CRASH-E2E-006 修复待最终复验

空闲容器或长驻Agent后端意外结束时，统一持久记录interrupted、证据版本下限、诊断与审计缺口。采用Docker wait及已有进程completion，不新增轮询守护服务。重复通知幂等，迟到完成不能清除故障；native/submit均要求显式恢复。正常停止及PTY普通完成不误报。fix round 1定向26项通过，类型及修改文件ESLint通过。真实容器复验和最终静态delta尚待完成。

- CRASH-SCAN-001：最终scanner发现故障后仍调用已死driver.stop，导致worker无法退出且公开恢复被拒绝。进入CRASH-E2E-006 fix round 2：故障收尾必须先确认整个任务写入者停止，再归还本worker租约并关闭；不得放宽存活进程恢复检查。最终全量与实际停止→恢复需要重新验证。

最终scanner `/root/native_final_scan` round 2静态delta：CRASH-SCAN-001 PASS，可关闭。确认先停止全部任务写入者再归还本worker租约，保留清理错误，恢复仍要求旧进程死亡；未运行产品或测试。CRASH-E2E-006累计2轮局部修复，实际退出及公开恢复仍待reviewer终态。

实际reviewer最终delta阶段：NATIVE-E2E-005真实Docker TTY通过（exit0、isTTY=true、中文及ANSI原样、无multiplex帧头）；REV-E2E-003实际CLI通过（exit1明确拒绝旧宿主会话、历史保留）。冷启动及审查/crash仍在核对。

## Human Escalation Stop：NATIVE-E2E-002

最终实际reviewer `/root/native_final_acceptance` 使用冻结构建、新建空会话及真实Codex TUI再次失败：exit1、sent=false，错误为 `failed to load a bounded thread item page`。此前两轮修复已覆盖resume/read/turns-list，但真实TUI继续请求条目分页。证据：忽略目录 `.local/evidence/direct-terminal/final/delta-screen.txt`、`delta-native-result.json`。未发送模型请求。

此项已达两轮修复上限，按rope-go升级人工处理，不继续逐API猜测补丁，不标原生首轮通过，不发布。最终综合裁定至少changes_requested；真实模型E2/E3/E5另因缺专用配置blocked。其余最终delta及资源清理继续收尾。

最终实际delta补充：REV-E2E-004通过，实际宿主Codex连接本机假401，CLI exit1/incomplete，诊断保留401 Unauthorized/synthetic denied与堆栈；冻结容器Paused=true，开发容器审查密钥检测false，pending=true。CRASH-E2E-006的137中断传播、版本递增、gap/failed事件及native拒绝通过；OOMKilled=false，不误判OOM。公开stop和resume均exit0、同UUID且不重放，但新worker因冷线程 `no rollout found` exit1，最终session-stop因socket不存在exit1。完整恢复就绪未通过，属于冷Codex同一阻塞的后果，不再第三轮修补。

## 最终裁定（2026-11-07）

- 模式：host-managed；最大就绪宽度4，计划3个实施叶加父执行者；最终scanner与reviewer分工，只有reviewer运行产品。
- Scanner `/root/native_final_scan`：passed；SEC1/WEB1/WEB2及CRASH-SCAN-001 delta已关闭。
- Reviewer `/root/native_final_acceptance`：changes_requested；NATIVE-E2E-002两轮仍失败，E1/E4 failed，E2/E3/E5/E6/E7/E8 blocked。
- 综合裁定：changes_requested，发布blocked，Human Escalation Stop。不得用两仓测试全绿替代实际入口失败。其他局部修复轮数：WEB1为2轮，CRASH-E2E-006为2轮，REV-E2E-001/003/004、NATIVE-E2E-005、SEC1/WEB2各1轮；不追加第三轮冷协议补丁。
- 最终检查：主仓lint/check/test/build退出0，315通过57跳过；Webcoding792通过、lint/check/build退出0。
- 资源：18个唯一归属清理后容器0、网络0、测试进程退出；详见私有final/acceptance-report.md及final-cleanup-verification.json。真实模型调用0。未发布、未提交推送。
- 下一步：先重新核对Codex空线程生命周期和真实TUI全部读取契约，再确定首次原生初始化方案；不能继续以逐API空历史兼容掩盖未产生rollout的事实。专用测试配置与未覆盖验收项另行补齐。

## 统一输入终审（2026-11-07，取代当前发布候选）

本节对应U01–U26。上文原生TUI失败保留为历史，不代表统一输入已通过。

- 初始静态轴：`/root/unified_final_scanner`，changes_requested。F01审查默认5秒超时、F02 Claude缺用户事件；网页旧宿主Codex诊断为note，未混入阻塞修复。
- 产品轴阶段：`/root/unified_final_reviewer`，changes_requested。实际复现F01，并发现F03 OpenCode正常停止误记137故障及增加证据版本。
- 三项均进入第1轮修复；F01/F02由`/root/unified_u20a`实施，F03由原scanner实施，故另换新静态叶复审，避免自审。
- 增量静态轴：`/root/unified_delta_scanner`，approve，findings=[]；主仓lint/check与4文件19项定向测试通过。确认仅review取消普通RPC总时限、Claude稳定用户事件及回显去重、主动停止确认后抑制预期退出且保留真实故障。
- 产品轴增量：`/root/unified_final_reviewer`确认F01/F02/F03最新dist实际复验通过，代码审核approve；产品验收blocked，剩余可独立本地执行的G0分支继续补测。真实模型专用配置仍缺，真实调用0，G2未发布，不重启或提交推送。
- 修复后冻结检查：主仓lint/check/test退出0，388项通过、57项配置跳过，85测试文件通过、30跳过，189.82秒；build退出0。Webcoding代码未再改动，先前全链退出0、794项通过仍有效。
- 当前证据：忽略目录`.local/evidence/direct-terminal/unified-final/acceptance-report.md`、`delta-verdicts.json`、`resource-verification.json`；首批24个归属ID核对容器/网络0、存活worker0。后续补测将单独记录资源归属及清理，不覆盖首轮失败。

### 统一输入最终裁定

- 模式：host-managed共享工作区，最大实施宽度3、计划3；父串行维护证据。双审使用具名通用叶，preset_missing；无模型覆盖或嵌套委派。
- 静态轴：`/root/unified_delta_scanner` approve，findings=[]。产品审核轴：`/root/unified_final_reviewer`代码approve、产品blocked。按最差轴综合blocked，发布blocked。
- F01/F02/F03均第1轮修复后实际复验通过，无未关闭的已证实代码阻塞；原生S/R旧失败保留，不沿旧方向追加补丁。
- UE1/UE3/UE4为报告限定G0场景passed；UE2/UE5 G0记录范围通过，真实模型与独立AI审查缺专用配置blocked；UE6未发布。未逐Agent重做同类kill或黑洞超时，不冒称已测；首提交竞态采用单测屏障补充实际EOF时序。
- 本轮新增三Agent终端→网页实际发送→终端续聊，首次401留存身份及请求，Codex容器KILL恢复/缺历史拒绝，无Git isolated固定报告不覆盖新开发。旧坏输出/401/超时固定补审明确复用私有final/review-results.json，不称本轮重跑。
- 最终证据：私有unified-final/acceptance-report.md及verdict.json；36个归属ID核对容器/网络/存活worker均0，隔离网页服务已退出。远程模型调用0，未借生产配置，未重启、发布或提交推送。

### 2026-11-07 维护修订复验

TERM-REV-001～006 完成，TERM-REV-007 暂缓。本轮由父代理修订并沿调用链自查，未新增委派或独立双审，不把此前 approve 当成本轮独立审核。故障与等待契约见 [终端维护边界](../../../devdocs/terminal-maintenance.md)。两仓 lint/check/test/build 退出 0；主仓396通过/57配置跳过，网页794通过，lint既有738警告/0错误。修正两处旧测试的时序依赖，生产停止与审计逻辑未因这些测试修订而改变。真实模型未调用，原发布门槛保持 blocked，未重启、提交或推送。
