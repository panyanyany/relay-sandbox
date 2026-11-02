# 行为策略执行任务

状态：completed；42个实施切片、2个修复子片、E1–E6、独立双轴审核及verify均已完成。以实测为依据，不以文档存在代替。

## Behavior Matrix

| ID | Given/When/Then 可观察行为 | Applies? | Verified at / 当前证据 |
| --- | --- | --- | --- |
| B01 | 新任务访问正常公网和任务外部内网服务，默认成功；不以私网地址为由额外拒绝。 | yes | E1；s16-entry-green.log + s04-green.log |
| B02 | 未授权访问宿主接口、登记公网映射及其他任务目标，连接被拒绝。 | yes | E1/E4；s16-entry-green.log + s09-green-final.log |
| B03 | 用户宿主配置授权目标、端口或网段后，只放行冻结授权范围。 | yes | E1/E2；s16-entry-green.log + s13-green.log |
| B04 | 同任务服务互通；其他任务稍后创建或恢复不使现有任务获得未授权访问。 | yes | E1/E6；s16-entry-green.log + s04-green.log |
| B05 | 正常安装修改沙箱可写配置可以成功，无权写入的系统文件仍失败且不自动提权。 | yes | E2；s16-entry-green.log |
| B06 | 向允许目标发送数据不新增内容阻断；正常通信不直接判恶意。 | yes | E4/E5；s16a-entry-green.log + policy-host-decoy-hit.json |
| B07 | 强制边界启动失败不派发开发；检测到运行失效停止任务，真实停止失败明确报告。 | yes | E6；s13-green.log + s13c-green.log（模拟503/真实资源） |
| B08 | 项目仅声明资源需求不能扩权；可信宿主配置才可授权。 | yes | E2；s01a-green.log + s02-green.log + s12-green.log |
| B09 | 运行中改权限/诱饵配置不影响本任务，恢复也不更新；新任务使用新快照。 | yes | E2/E6；s12-green.log + s13-green.log |
| B10 | 默认资源副本与宿主源分离，修改不会直接写回额外源目录。 | yes | E3；s16-entry-green.log + s06-green.log |
| B11 | 直接只读拒绝写入；直接可写允许立即修改且报告绕过交付审核的影响。 | yes | E3/E5；s16-entry-green.log + policy-host-direct-write.json |
| B12 | 冲突目标、不可保证的路径或挂载边界明确失败；清理不删除授权源。 | yes | E3/E6；s05-green.log + s13-green.log |
| B13 | 缺省配置不投放诱饵、不创建诱饵代理或修改客户端信任配置。 | yes | E2；s12-green.log + s16-entry-green.log |
| B14 | 显式开启才无冲突投放；已有配置、常用凭据变量和真实凭据不变，冲突跳过可查。 | yes | E2；s12a-green.log + s12d-green-final-state.log |
| B15 | 已验证 curl/wget/Python 组合首次正常 TLS 请求成功、可观察；未知组合预先免解密。 | yes | E4；s10-green.log + s11-green.log + s16a-entry-green.log |
| B16 | 原值和约定常见编码出现在可见请求时记录命中；不宣称命中就等于恶意或远端已收到。 | yes | E4/E5；s16a-entry-green.log + policy-host-decoy-hit.json |
| B17 | 未知客户端、内容审计故障或无法观察时请求按原权限可继续，覆盖缺口可见。 | yes | E4/E6；s16a-entry-green.log + s13-green.log + policy-host-audit-gap.json |
| B18 | 无论解密或免解密，都不关闭真实网站证书验证，证书错误照常失败。 | yes | E4；s09-green-final.log + s10-green.log + s11-green.log + s16a-entry-green.log |
| B19 | 正常候选遇运行风险仍按冻结策略交付并提醒；候选自身恶意由启用的代码审查拒绝。 | yes | E5；policy-host-{decoy-hit,malicious,direct-write,audit-gap}.json实际emitted |
| B20 | 新增快照摘要参与审核绑定；旧任务无新快照按旧边界处理，不静默改为新授权。 | yes | E2/E6；s12-green.log + s13-green.log + 既有recovery.test.ts |
| B21 | 持久化日志和用户报告仅最小命中字段，无请求全文/片段、诱饵原值、真实凭据。 | yes | E4/E5；F01后reviewer-fix-redaction-probe.log确认rawDecoyLeaked:false，四宿主卫生断言通过 |
| B22 | 任务指标包含辅助容器，停止/cleanup/gc 删除代理与私钥、到期证据，保留源目录和备份。 | yes | E6；s13-green.log + s13a-green-final.log + s16b-green.log |

缺省、非法、重复、不可用与边界均已在 B07–B22 覆盖。重复投放应保持同任务清单且不覆盖现有文件，重复清理保持源目录；无诱饵时不得生成虚假命中。

## 执行与文件归属规则

- 模式：shared / host-managed；无 Git，D19 明确豁免 commit/worktree，父代理保存受控文件基线清单与摘要，不覆盖无关变更。
- 各切片最多约 400 行改动、4 个归属源码/测试文件；下表已将提纲中的集成验收与文档大块重切为 S15–S20，功能范围不变。代码超限再切，不能压行或删中文注释。
- 每个源码/测试文件只有一个切片归属。需要跨归属补接线时由父代理重切任务并记录移交，不能让并行实现者同时改核心文件。
- 新模块在组件切片可独立测试，S12 才将冻结授权和组件统一接入任务创建/最终检查；不提前宣称产品已可用。
- 公共运行选项契约由 S01 定义，S04 的运行时接入消费该契约；S06 只生成选项，S12 编排调用，不反复抢写 runtime.ts。
- 框架不存在预设时使用通用实现/审核 agent，无模型指定；按 rope-go 禁止嵌套委派。
- 所有源码切片 TDD required：一个验收点先 red，再最小 green，记录命令与失败原因；无意义的实现镜像测试不算证据。
- 测试 seam 与约束以 prd.md 为准；依赖/设计无法满足契约时停止回 shape，不能删验收项换绿。
- 问题修复最多两轮，架构或授权矛盾立即停止；提交/推送不执行。

## S01：配置契约

- Status: completed
- Kind: contract
- Goal / Public behavior: 严格权限/诱饵 Schema 及独立运行时选项类型可解析，未知/非法项失败，不改变旧字段含义。
- Blocked by: none
- Owned files: `src/permissions/schema.ts`；`src/permissions/types.ts`；`tests/unit/policy-contract.test.ts`
- Size cap: 320 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B08/B13/B20；Constraint IDs: C1/C6/C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S02：可信加载与冻结

- Status: completed
- Kind: contract
- Goal / Public behavior: 宿主 projectId 策略与项目申请分离，返回版本化快照及摘要；无文件默认无授权，坏配置报错。
- Blocked by: S01
- Owned files: `src/permissions/load.ts`；`src/permissions/freeze.ts`；`tests/unit/permission-load.test.ts`
- Size cap: 360 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B08/B09/B20；Constraint IDs: C1/C6；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S03：网络边界规划

- Status: completed
- Kind: contract
- Goal / Public behavior: 规划明确的允许/拒绝规则与任务网络身份，支持冻结例外，不再把全部内网视为禁止。
- Blocked by: S02
- Owned files: `src/network/task-boundaries.ts`；`src/network/planner.ts`；`tests/unit/network-plan.test.ts`
- Size cap: 360 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B01/B02/B03/B04；Constraint IDs: C1/C2/C3；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S04：真实网络接入

- Status: completed
- Kind: vertical
- Goal / Public behavior: Docker 运行时接受显式冻结运行选项；真实新边界能执行，创建失败不运行 Agent。
- Blocked by: S03
- Owned files: `src/network/policy.ts`；`src/docker/runtime.ts`；测试归属移至 S04A，仍作为本片 TDD 验收。
- Size cap: 400 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B01/B02/B03/B04/B07；Constraint IDs: C2/C3/C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S05：授权副本准备

- Status: completed
- Kind: contract
- Goal / Public behavior: 验证源及目标边界并生成独立副本，未知或冲突资源不能隐式扩权。
- Blocked by: S02
- Owned files: `src/resources/paths.ts`；`src/resources/copy.ts`；`tests/unit/resources.test.ts`
- Size cap: 340 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B10/B12；Constraint IDs: C1/C4；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S06：直接资源共享

- Status: completed
- Kind: vertical
- Goal / Public behavior: 为显式授权生成受限 Docker mount 选项，真实只读/可写行为可验，不删除源目录。
- Blocked by: S04,S05
- Owned files: `src/resources/mounts.ts`；`src/resources/prepare.ts`；`tests/integration/resource-access.test.ts`
- Size cap: 360 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B10/B11/B12；Constraint IDs: C1/C4/C10；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S07：可选诱饵投放

- Status: completed
- Kind: contract
- Goal / Public behavior: 每任务无效诱饵清单及投放计划独立，默认关闭，有冲突跳过且不改既有凭据。
- Blocked by: S02
- Owned files: `src/decoys/manifest.ts`；`src/decoys/placement.ts`；`tests/unit/decoys.test.ts`
- Size cap: 360 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B13/B14；Constraint IDs: C1/C6；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S08：有界编码匹配

- Status: completed
- Kind: contract
- Goal / Public behavior: 匹配原值与明确常见编码，返回最小事件及覆盖不足；缓冲和解码有界，输出不含原文。
- Blocked by: S07
- Owned files: `scripts/traffic-match.py`；`src/traffic/events.ts`；`tests/unit/traffic-matcher.test.ts`
- Size cap: 360 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B16/B21；Constraint IDs: C8/C9；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S09：任务私有代理

- Status: completed
- Kind: vertical
- Goal / Public behavior: 固定成熟代理版本，实现真实 HTTP/HTTPS 最小事件出口、私有 CA 和受限网络，关闭原始 flow 日志。
- Blocked by: S04,S08
- Owned files: `images/traffic.Dockerfile`；`scripts/traffic-addon.py`；`src/traffic/runtime.ts`；测试移交S09B。
- Size cap: 400 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B02/B16/B18/B21；Constraint IDs: C2/C3/C7/C8/C10；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S10：curl/wget 兼容入口

- Status: completed
- Kind: vertical
- Goal / Public behavior: 经核对的 curl/wget 调用组合可观察，未知参数/信任设置不盲目接入解密，首次请求与 TLS 验证行为正确。
- Blocked by: S09
- Owned files: `src/traffic/clients.ts`；`scripts/traffic-client.py`；测试归属移交S10B。
- Size cap: 380 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B15/B17/B18；Constraint IDs: C3/C7/C8；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S11：Python 明确客户端组合

- Status: completed
- Kind: vertical
- Goal / Public behavior: 按明确库/版本/配置提供受控 Python HTTP 客户端入口，未知 Python 调用保持原通信路径；构建带齐辅助文件。
- Blocked by: S10
- Owned files: `scripts/traffic-python.py`；`scripts/build-assets.mjs`；`src/traffic/clients.ts`仅已验证Python条目扩展；测试移交S11B。
- Size cap: 340 行预计上限 / 3 个归属文件；超限重新切分。
- Matrix rows: B15/B17/B18；Constraint IDs: C7/C8/C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S12：创建与检查组合

- Status: completed
- Kind: vertical
- Goal / Public behavior: 真实创建任务冻结并安装环境，最终检查复用同一授权，默认关闭不投放/代理，不污染交付清单。
- Blocked by: S06,S07,S11,S12A,S12C,S12D,S12E
- Owned files: `src/tasks/create.ts`；`src/tasks/candidate.ts`；`tests/integration/policy-task.test.ts`；environment移交S12C，安装移交后续S12D。
- Size cap: 400 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B08/B09/B10/B13/B14/B20；Constraint IDs: C1/C2/C3/C4/C6/C7；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S13：监督恢复与清理

- Status: completed
- Kind: vertical
- Goal / Public behavior: 监督刷新边界及恢复使用冻结快照；辅助组件故障降级，清理不留孤儿、不删源，证据按保留期回收。
- Blocked by: S12
- Owned files: `src/tasks/recovery.ts`；`src/tasks/cleanup.ts`；`src/tasks/garbage-collection.ts`；`tests/integration/policy-lifecycle.test.ts`
- Size cap: 400 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B04/B07/B09/B12/B17/B20/B22；Constraint IDs: C1/C2/C3/C10；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S14：事实报告与影响范围

- Status: completed
- Kind: vertical
- Goal / Public behavior: 结果及报告区分受控交付、直接共享可能影响、命中与未知覆盖，不把未应用等同宿主没变。
- Blocked by: S13
- Owned files: `src/reporting/policy-summary.ts`；`src/reporting/user-report.ts`；`src/tasks/result.ts`；`tests/unit/policy-report.test.ts`
- Size cap: 360 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B06/B11/B16/B17/B19/B21；Constraint IDs: C4/C5/C8/C9；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S15：CLI/MCP 能力与入口

- Status: completed
- Kind: vertical
- Goal / Public behavior: 通过既有任务与结果工具发现实际权限和审计能力，入口只校验与委托，不让 MCP 自行授权。
- Blocked by: S14
- Owned files: `src/mcp/server.ts`；`src/mcp/capabilities.ts`；`src/cli/main.ts`；`tests/unit/mcp.test.ts`
- Size cap: 320 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B08/B13/B17/B19/B21；Constraint IDs: C1/C5/C6/C7/C9/C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S16：真实任务入口验收

- Status: completed
- Kind: vertical
- Goal / Public behavior: 从真实 CLI/MCP 入口贯通授权、执行、交付和清理；使用专用最小项目及真实 Docker/证书/网络。
- Blocked by: S15
- Owned files: `tests/e2e/policy-flow.test.ts`；`tests/helpers/policy-fixture.ts`
- Size cap: 380 行预计上限 / 2 个归属文件；超限重新切分。
- Matrix rows: B01–B22；Constraint IDs: C1–C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S17：真实宿主最终上报

- Status: completed
- Kind: vertical
- Goal / Public behavior: 实际 Codex 宿主经已授权接口发现能力、审核并输出；验证正常候选+运行风险不误拒、最终消息与事实报告一致。
- Blocked by: S16
- Owned files: `tests/e2e/policy-host.test.ts`；`tests/helpers/host-codex.ts`
- Size cap: 360 行预计上限 / 2 个归属文件；超限重新切分。
- Matrix rows: B06/B11/B16/B17/B19/B21；Constraint IDs: C4/C5/C8/C9；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: required；只运行本切片列出的测试 seam，先 red 后 green，结果写入进度日志。
- Verification: 新增/修改测试的定向 Vitest；Python 组件通过测试进程调用标准库接口；Docker 测试显式启用，不虚构跳过为通过。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S18：需求与行为文档

- Status: completed
- Kind: docs-only
- Goal / Public behavior: 同步已实现与已验证范围，明确替代旧内网规则，保留未验限制。
- Blocked by: S17
- Owned files: `devdocs/requirements.md`；`devdocs/decisions.md`；`devdocs/architecture.md`；`devdocs/user-reporting.md`
- Size cap: 300 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B01–B22；Constraint IDs: C1–C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: waived (docs-only)，核对实际结果及相对链接。
- Verification: 文档一致性、链接和术语核对。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S19：运行与验收文档

- Status: completed
- Kind: docs-only
- Goal / Public behavior: 给出可执行配置/命令、支持客户端组合、代理与证据清理、测试结果和未验项。
- Blocked by: S17
- Owned files: `devdocs/usage.md`；`devdocs/observability.md`；`devdocs/implementation-validation.md`；`devdocs/validation.md`
- Size cap: 360 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B01–B22；Constraint IDs: C1–C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: waived (docs-only)，核对实际结果及相对链接。
- Verification: 文档一致性、链接和术语核对。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## S20：索引与功能入口

- Status: completed
- Kind: docs-only
- Goal / Public behavior: 更新入口索引及中文文件树，集中说明当前生效策略、例外与功能限制；准备双轴终审。
- Blocked by: S18,S19
- Owned files: `README.md`；`AGENTS.md`；`devdocs/structure.md`；`devdocs/behavior-policy.md`
- Size cap: 300 行预计上限 / 4 个归属文件；超限重新切分。
- Matrix rows: B01–B22；Constraint IDs: C1–C11；Architecture sources: prd.md A1–A7 按约束对应。
- TDD: waived (docs-only)，核对实际结果及相对链接。
- Verification: 文档一致性、链接和术语核对。
- Evidence：本文件进度日志和对应s切片证据；独立Review统一见review.md，不以实现自检代替终审。

## 执行图与并行声明

原shape为20切片/15波；因预算和安全安装边界重切为42个切片，不再沿用原最长路径/波数。下面列出依赖汇合顺序，实际并发及顺序移交见日志；不是工期估算。

1. S01 → S01A/S02 → S03/S05/S07。
2. S03 → S04 → S04A；S05 → S06；S07 → S08。
3. S04/S08 + S09A → S09 → S09B；S10A固定开发工具版本。
4. S07 → S12A；S12B脱敏；S02/S06 → S12C；S09 → S12E。
5. S09/S10A → S10 → S10B → S11/S11A → S11B。
6. S11/S12A/S12C/S12E → S12D → S12G。
7. S12D/S12G → S12/S12F/S13A；三者产品路径互斥。
8. S12/S13A → S13 → S13B/S13C；S14A → S14；S15能力说明与其接线顺序移交。
9. S13/S14/S15 → S16 → S16A；S16B补代理指标；S17A → S17。真实Docker任务创建及宿主模型验收最终按父代理顺序排队，避免跨进程地址分配竞态。
10. S18/S19/S20同步文档与索引 → 全局检查/构建 → 两个新身份独立scanner/reviewer → rope-verify。

最多3个实现agent加父代理；同一路径始终单一归属，不使用Git隔离。父代理的忽略配置、证据读取和文档修改也有明确切片。无关变更不纳入本包。最终双审身份不复用实现者。

## 审核栏

| 维度 | 审核者 | 结果 | 证据/修复轮次 |
| --- | --- | --- | --- |
| 静态规范与可维护性 | /root/final_scanner | PASS | Round2，修复1轮；scanner-review.md |
| 实际入口行为与边界 | /root/final_reviewer | PASS | Round2，完整回归及真实日志复核；reviewer-review.md |
| 汇总 | parent | PASS | 两轴均PASS；verify.md |

## 进度日志

| 日期 | 阶段/切片 | 动作 | red / green / 真实证据 | 下一步 |
| --- | --- | --- | --- | --- |
| 2026-11-02 | shape | 需求、提纲及 host-managed 已确认；按预算重切为 20 个小切片，未实施 | 基线 lint/check/test 通过，24 项常规测试；新增功能证据 pending | 确认 Contract Note 和执行门槛 |

日志须追加保留失败，不将跳过、未运行或缺口记为通过。每片完成更新状态和证据；全部功能完成后更新 devdocs，再进行双轴审核与 rope-verify。

| 2026-11-02 | go 启动 | 用户确认实施；共享模式最多3并行；S01已派发通用实现agent，preset_missing，不指定模型 | 基线24项通过；原文件副本和SHA256在.local/evidence/behavior-policy/baseline | S01 green后S02 |


## S01A：项目资源申请声明（补充小切片）

- Status: completed
- Blocked by: S01；S02 可同时实现可信加载，不共享文件。
- Owned files: src/config/schema.ts、tests/unit/resource-request.test.ts。
- Scope: 仅命名 resourceRequests，不接受授权对象；C1/C11，B08。
- TDD: required；red 已确认缺省 resourceRequests 未定义；证据 s01a-red.log。
- Size cap: 100 行/2 文件；不改变已有 resources 运行限额字段。

| 2026-11-02 | S01 | completed，通用实现agent s01_contract，preset_missing | 4项定向测试、ESLint/check通过；s01-red.log/s01-green.log | S02已派发 |

| 2026-11-02 | S01A | completed，父代理补齐项目仅命名申请 | s01a-red.log缺省字段断言失败；s01a-green.log 1项通过 | S02继续可信加载 |

| 2026-11-02 | S02/S03/S05/S07/S08 | completed；可信加载冻结、网络规划、资源副本、诱饵及有界匹配完成组件层 | 各自s02/s03/s05/s07/s08-red及green/lint/check日志；4/4/3/4/4项测试通过 | S04真实Docker接入；不视为产品已生效 |

## S10A：受支持客户端镜像准备（补充小切片）

- Status: completed
- Owned files: images/Dockerfile；父代理独占。
- Scope: 为已确认 wget 支持补齐开发镜像工具；不改默认代理或信任。
- TDD: waived（构建依赖声明）；真实重建镜像后读取 curl/wget/Python 版本，S10 验收行为。
- Size cap: 10行/1文件；与S04归属无重叠。

## S04A：真实网络验收（预算重切）

- Status: completed
- Blocked by: S03；与S04同一实现agent顺序完成，Wave5等待两片green。
- Owned files: tests/integration/network-policy.test.ts；tests/integration/runtime.test.ts。
- Scope: S04真实Docker red/green证据；公网、内网成功对照，宿主/未来任务拒绝、显式例外与失败回收。
- Size cap: 350行/2文件；从S04移交测试归属，未改变B01–B04/B07及C2/C3/C11。
- TDD: required；已有真实red为未采用专用池，最终复验实际端点可达性。

| 2026-11-02 | 基线复核 | 仅运行原始manifest中的测试路径，排除私有快照发现干扰 | go-baseline-original.log：24 passed、18显式集成用例skipped，退出0 | S04/S04A |

| 2026-11-02 | S04/S04A | completed；真实运行时默认legacy、新任务显式default-open，规则安装后才返回 | s04-red/green.log；真实Docker 3项通过，定向ESLint/check通过；同目标跨任务授权正对照只改任务NS路由 | Wave5：S06/S09并行；S10只读预研 |

| 2026-11-02 | S10A | completed；固定开发镜像补齐wget并真实重建，默认代理/信任未改 | dev-image-build.log退出0；dev-client-versions.log；image 5c11145ed971 | S10验证实际客户端行为 |

## S09A：代理镜像构建上下文（补充小切片）

- Status: completed
- Owned files: .dockerignore；父代理独占。
- Scope: 仅放行代理Dockerfile与两份固定审计脚本，不将本机私有数据加入构建上下文。
- TDD: waived（构建配置）；S09首次真实构建排除scripts失败已留日志，配置修复后由S09重建验收。
- Size cap: 10行/1文件；C8/C11；不扩大代理权限。

## S09B：代理真实证书与最小证据验收（预算重切）

- Status: completed
- Owned files: tests/integration/traffic-proxy.test.ts；与S09同agent顺序实施。
- Blocked by: S04/S08；下波S10等待S09/S09B完整green。
- Size cap: 300行/1文件；B02/B16/B18/B21、C2/C3/C7/C8/C10。
- TDD: required；验证真实HTTP/HTTPS、同端点可信/不可信上游CA对照、最小事件、容量与敏感host脱敏。

## S12A：容器内无覆盖诱饵安装（预算重切）

- Status: completed
- Blocked by: S07；从S12环境组合剥离，组件已就绪提前并行，不与S09共享归属。
- Owned files: src/decoys/install.ts；scripts/decoy-install.py；tests/integration/decoy-install.test.ts。
- Size cap: 350行/3文件；S12剩余编排显式依赖本片。
- Public behavior: 禁用无操作、独立文件0600、冲突及链接祖先跳过，已有配置/项目不变，只返回无值摘要。
- TDD: required；真实Docker安装、重复、链接冲突和原文件保持。
- Constraints: C6/C8/C11，B13/B14/B21；使用dirfd/O_NOFOLLOW/O_EXCL处理写入竞态。

| 2026-11-02 | S06 | completed；真实copy、direct-ro、direct-rw、复用和清理通过 | s06-red/green/lint/check.log；check当前仅被并行S09类型错误阻塞，最终总检复核；root宿主ownership未实测 | S09/S09B继续，S12A独立提前组件实施 |

## S12B：日志中的诱饵原值脱敏（预算重切）

- Status: completed
- Blocked by: S07；S10前独立完成，不改任务编排。
- Owned files: src/audit/redaction.ts；tests/unit/decoy-redaction.test.ts。
- Scope: 开发输出或错误出现严格格式假凭据时脱敏，清理私密清单后报告仍不暴露原值；不宣称通用DLP。
- Size cap: 100行/2文件；C8/C11、B21。
- TDD: required，裸fake值输出与堆栈先red后green，断言布尔泄漏避免证据记录原值。

| 2026-11-02 | S12A | completed；无覆盖投放、链接祖先防护及最小输出 | s12a-red/green/lint/check.log；真实Docker1项通过；全check仅并行S09测试类型错误 | S11复制decoy-install.py，S12调用installer |

| 2026-11-02 | S09/S09B/S12B | completed；真实HTTP/TLS代理、最小证据轮转与清理；通用日志脱敏假凭据原值 | s09-green-final.log 1项通过、lint/check通过；s12b-green.log 3项通过；失败轮保留 | S10显式客户端入口，依赖关系暂仅1实现片就绪 |

## S12C：冻结摘要与资源环境组件（预算重切）

- Status: completed
- Blocked by: S02/S06；依赖已完成，S10期间并行，不抢占客户端归属。
- Owned files: src/tasks/environment.ts；tests/unit/task-environment.test.ts。
- Size cap: 300行/2文件；从原S12剥离，C1/C4/C6/C11、B08/B09/B10/B20。
- Scope: freezeEnvironment同时绑定项目与策略摘要；prepareEnvironment生成明确mounts/default-open授权；旧任务无snapshot返回legacy空options；不安装代理/诱饵。
- TDD: required，真实临时fs冻结/摘要/副本复用/旧任务，不新增Docker假对象。
- Next: S12D负责独立安装模块；原S12在所有组件完成后只接线与真实任务验收。

| 2026-11-02 | S12预算再切 | 采纳组件预研，冻结资源S12C可与S10并行；代理/客户端安装S12D等待S11 | 文件归属互斥；不提前宣称入口生效 | S12C / S10 |

## S10B：curl/wget真实兼容验收（预算重切）

- Status: completed
- Owned files: tests/integration/traffic-clients.test.ts；S10同agent顺序完成。
- Size cap: 300行/1文件；原S10条件及C3/C7/C8/C11不变。
- TDD: required；首次TLS成功/命中、未知组合预先免解密、代理故障直通、真实坏证书失败；S11等待完整green。

| 2026-11-02 | S12C | completed；冻结授权/项目摘要绑定及资源复用组件 | s12c-red/green/lint/check.log；真实fs2项通过，lint/check通过 | 原S12仅待安装组件与入口组合 |

## S12E：独立公共工具安全安装（预算重切）

- Status: completed
- Blocked by: S09；S10期间并行，归属互斥；供后续S12D消费。
- Owned files: src/traffic/install.ts；scripts/traffic-install.py；tests/integration/traffic-install.test.ts。
- Size cap: 350行/3文件；C6/C7/C8/C11，B13/B15/B21。
- Scope: 仅固定保留根/opt/relay-sandbox/audit/<runtimeId>，安装公共CA/helpers/catalog，root-owned、无覆盖、无链接祖先穿越；不接受私钥/manifest。
- TDD: required；真实Docker可读/可执行但开发UID不可改、已有文件保持、链接和路径穿越拒绝。
- Build assets: S11需复制traffic-install.py；禁用诱饵分支不调用此组件。

| 2026-11-02 | S10/S10B | completed；显式curl/wget受控入口，未知/故障直通，无自动重放 | s10-red/green.log；真实Docker1项通过，ESLint/check通过；版本探测异常分支未单独注入 | S12E终态后S11 urllib及构建资产 |

## S12D：独立运行环境安装组合（预算重切）

- Status: completed
- Blocked by: S11/S12A/S12C/S12E；S11客户端脚本完成后实施。
- Owned files: src/tasks/environment-install.ts；src/tasks/environment-state.ts；src/traffic/runtime.ts仅stopTraffic最小输入类型移交（由S09归属顺序移交，无并发）；测试移交S12G。
- Size cap: 400行/4文件，超限再切测试；C3/C6/C7/C8/C10/C11、B13/B14/B15/B17/B21/B22。
- Scope: installDecoys+startTraffic+公共CA/helpers安装；每runtime独立private/evidence目录；公开summary无原值，私有handle只存标识/受控路径，不存CA Buffer/匹配值；关闭零安装，审计失败固定gap并保留强制隔离。
- TDD: required，真实Docker开关/脚本可用/无私钥泄漏/审计启动失败降级/单独candidate目录；清理双方都尝试，失败聚合不假报。
- Boundary: 原S12负责create/candidate实际接线，S13负责监督/恢复/cleanup/gc，S14负责报告读取。

| 2026-11-02 | S12E | completed；公共工具独占、root-owned、安全安装 | s12e-red/green/lint/check.log；真实Docker1项通过，ESLint/check通过 | S11现实现urllib及构建资产 |

## S11A：Python缓存排除（补充配置切片）

- Status: completed
- Owned files: .gitignore；父代理独占。
- Scope: 排除Python辅助脚本导入产生的__pycache__和pyc，不收录生成文件。
- TDD: waived（忽略配置）；Docker上下文仍采用明确准入，不包含缓存。
- Size cap: 10行/1文件；review diff也排除这些生成文件。

## S11B：urllib真实兼容验收（预算重切）

- Status: completed
- Owned files: tests/integration/traffic-python.test.ts；S11同agent顺序完成。
- Size cap: 300行/1文件；保留原S11所有C7/C8/C11及B15/B17/B18。
- TDD: required；真实首次TLS命中、未知/自定义信任/代理与CA损坏降级、坏证书失败与不重放。

## S12F：开发Agent显式入口提示（接线补充切片）

- Status: completed
- Blocked by: S12D；与原S12可同时实施，归属无重叠。
- Owned files: src/tasks/run.ts；src/traffic/guidance.ts；tests/unit/traffic-guidance.test.ts。
- Size cap: 200行/3文件；C6/C7/C11，B15/B17。
- Scope: 从可信最新main公开环境摘要给开发Agent正向说明显式入口用法，恢复后跟随新helperRoot；不暴露诱饵位置/值，不把工具装好等同调用过。
- TDD: required；off/不可用不提供失效代理入口，ready仅保留路径与受控argv，无shell插值或全局env。

| 2026-11-02 | S11/S11B | completed；明确urllib.request@3.11.2入口及五项构建资产 | s11-red/green/ca-green/assets.log；S10+S11真实Docker2项通过、ESLint/check通过 | S12D安装编排；之后原S12与S12F并行接线 |

## S12G：环境安装真实组合验收（预算重切）

- Status: completed
- Owned files: tests/integration/environment-install.test.ts；S12D同agent顺序实施。
- Size cap: 250行/1文件；原S12D全部行为与约束不变。
- TDD: required；missing-module仅早期记录，早期import-red在实现前，行为mutation-red在green后，不能冒充先行为red；禁用零安装、启用安全公共文件与最小状态、check不抢主、安装冲突降级。

| 2026-11-02 | S12D/S12G | completed；主/检查环境独立、公开工具组合、状态和历史诱饵匹配 | s12d-green-final-state.log真实Docker1项通过18.89秒、lint/check通过；原始import-red在实现前，behavior-red为实现后故障注入，明确区分 | 原S12+S12F并行接线；S13只读预研 |

## S13A：环境生命周期组件（预算重切）

- Status: completed
- Owned files: src/tasks/environment-lifecycle.ts；tests/integration/environment-lifecycle.test.ts。
- Size cap: 400行/2文件；原S13约束和B07/B09/B17/B22不变。
- Scope: 独立停止/检查辅助代理、私钥回收与缺口；半启动目录和孤儿容器可清理，证据/主诱饵保留。
- TDD: required；真实自有Docker退出、停止、秘密与证据边界及失败状态。

## S13B：生命周期入口验收（预算重切）

- Status: completed
- Owned files: tests/integration/policy-lifecycle.test.ts；原S13产品三文件先实施，再顺序移交测试。
- Size cap: 300行/1文件；原S13行为和约束不变。
- TDD: required；真实public入口恢复/停止/cleanup/gc及失败不假报。

## S14A：有界最小流量证据读取（预算重切）

- Status: completed
- Owned files: src/reporting/traffic-evidence.ts；tests/unit/traffic-evidence.test.ts；父代理独占。
- Size cap: 400行/2文件；C6/C8/C10/C11、B16/B17/B21。
- Scope: nofollow逐层目录句柄，读取前和期间大小限制及元数据复核；最多128环境、每类3段1MiB、公开最多100条最小事件；损坏/缺失/轮转显式缺口。
- TDD: required；s14a-red.log（实现前缺模块）、s14a-green.log（真实行为失败）、s14a-green-final.log（2项通过）、lint/check均通过。

| 2026-11-02 | S12 | completed；创建/候选实际消费冻结授权、资源与审计安装 | s12-green.log真实Docker2项通过19.07秒，lint/check通过 | S13生命周期 |
| 2026-11-02 | S12F | completed；实际开发prompt附加当轮显式工具入口 | s12f-red/green/lint/check.log；真实metadata2项通过；AI实际使用留S16 | S13并行S14 |

| 2026-11-02 | S14A | completed；最小流量证据读取与拒绝链接/超限 | s14a-green-final.log 2项通过；s14a-lint/check.log exit0；早期真实行为失败保留 | S14消费 |

### S15 接线执行说明

父代理在S14期间先完成互不重叠的能力/工具说明及stdio契约测试。S15终态须等S13/S14产品字段接通后复核，不能提前宣称恢复监督通过。仅编辑原S15四个归属文件，未新增工具或授权接口。

## S16A：任务入口通信组合验收（预算重切）

- Status: completed
- Owned files: tests/e2e/policy-traffic.test.ts；tests/helpers/policy-traffic-fixture.ts。
- Size cap: 400行/2文件；S16同agent顺序，C2/C3/C6/C7/C8/C9，E4/B15–B18/B21。
- Scope: 实际任务安装后的显式helper、首次TLS、编码与免解密/故障及报告；测试代理只增加隔离上游测试CA，不关闭验证、不改宿主信任。

## S17A：真实宿主合成夹具（预算重切）

- Status: completed
- Owned files: tests/helpers/policy-host-fixture.ts；S17同agent先夹具后测试，不抢写。
- Size cap: 220行/1文件；原S17全部隐私/授权与E5约束。
- Scope: 合成中转站与临时源/接收端，不将攻击fixture命令交付为候选，不记录请求正文。

| 2026-11-02 | S13A | completed；真实proxy退出只降级、停止和半启动秘密清理 | s13a-red真实行为失败；s13a-green-final1项通过11.12秒，lint/check通过 | S13消费 |
| 2026-11-02 | S14 | completed；可信冻结影响和最小证据接入结果/用户报告 | s14-green4项通过，lint/check通过 | 实际宿主E5 |
| 2026-11-02 | S15 | completed；MCP能力/说明、CLI doctor和真实stdio握手 | s15-red/green/lint/check.log，exit0 | 实际宿主发现 |
| 2026-11-02 | S18 | completed；需求/决策/架构/上报同步D25；保留历史决策 | devdocs四文档；不把组件通过写作全E2E完成 | S19/S20最终证据更新 |
| 2026-11-02 | 全局中检 | lint/check/test通过；59 passed、33 skipped | go-suite.log；跳过组不是通过，源码仍在增量接入 | 完成后全检查/真实Docker/独立双审 |

## S13C：停止API失败不虚报（预算重切）

- Status: completed
- Owned files: tests/integration/policy-stop-failure.test.ts；原S13同agent顺序。
- Size cap: 200行/1文件；C3/C10/C11、B07。
- Scope: 真实容器，test-only模拟指定stopAPI503，证明未停止容器仍运行、任务不报stopped，其他容器确实停止，恢复API后可重试。非daemon自然故障。
- Evidence: s13c-green.log 1项通过9.31秒；paused容器probe自动停止，不计失败证据。

## S16B：辅助代理真实指标（验收补充）

- Status: completed
- Owned files: tests/integration/traffic-metrics.test.ts；父代理独占。
- Size cap: 120行/1文件；C10、B22/E6。
- Scope: 实际创建任务与代理，采样并验证代理CPU/内存单独记录；无模型调用，不以开发容器指标代替代理。
- TDD: acceptance-only；已有通用采集实现，真实组合验收不伪造先红后绿。

| 2026-11-02 | S13/S13B/S13C | completed；冻结恢复、mandatory停止、内容降级、真实清理失败重试及orphan到期证据 | s13-green4项53.67秒；s13c-green1项9.31秒；lint/check通过。模拟503与真实daemon故障明确区分 | 最终完整构建及审核 |
| 2026-11-02 | S16 | completed；实际CLI/MCP网络/授权/资源/安装及报告 | s16-entry-green2项33.76秒；首轮Docker桥隔离夹具失败保留；lint/check通过 | S16A实际TLS组合 |
| 2026-11-02 | S17 首轮 | 2 passed / 2 failed；直接可写恶意候选拒绝、审计缺失正常交付已emitted；另两项夹具启动失败 | s17-host.log；不把夹具失败算宿主审核失败或通过 | 修就绪检测，只重跑失败项 |

| 2026-11-02 | S16A | completed；真实安装入口首次TLS/编码/直通/坏证书/退出gap/卫生 | s16a-entry-green1项24.85秒；首轮断言错误保留，定向lint/check通过 | 最终审核复核 |
| 2026-11-02 | S16B | completed；真实辅助代理CPU/内存独立指标 | s16b-green1项8.21秒；早期类型字段错误已修正 | 完整suite及E5失败项定向重测 |

| 2026-11-02 | S17/S17A | completed；四个真实宿主场景最终输出与emitted均通过 | s17-host首轮2通过2夹具失败；s17-host-retry定向2通过2不重跑；四个policy-host-*.json，隐私断言通过 | 独立双轴审核 |
| 2026-11-02 | S19/S20 | completed；功能devdocs、行为策略操作、中文文件树及索引同步 | E1–E6均已留证；最终常规59通过42跳过，build通过；失败/部分覆盖/测试信任边界明确 | 双审判定后追加终态 |

| 2026-11-02 | 架构文档 | A1–A7全部completed；具体路由写入prd.md终态表 | README/AGENTS/structure及devdocs已同步，本地Markdown链接检查0断链 | 双审及verify |

## 终审修复轮1

### F01：完整原值拼接脱敏

- Status: completed
- Owned files: src/audit/redaction.ts；tests/unit/decoy-redaction.test.ts；原S12B归属由父明确顺序移交s01_contract。
- Size cap: 120行/2文件；C8/B21，唯一blocking。
- TDD: required；prefix/suffix/65hex含完整raw的布尔断言先red，修regex后green，formatError堆栈与cause仍保留。
- 不扩大为任意变换DLP，不依赖已清理manifest，不在red输出中打印值。

### F02：共享环境持久Schema

- Status: completed
- Owned files: src/tasks/environment-state.ts；src/reporting/policy-summary.ts；S12D/S14明确顺序移交s05_resources。
- Size cap: 120行/2文件；维护性note，唯一版本化持久契约，报告保留边界/投影校验。
- TDD: behavior-preserving-refactor；既有有意义回归，不伪造red。

| 2026-11-02 | 终审第1轮 | scanner/reviewer均CHANGES_REQUESTED，唯一raw拼接阻断；维护建议Schema重复 | scanner-review.md/reviewer-review.md；完整Docker22通过，E2E7通过13显式skip；真实Codex roundlog probe证实原值泄漏，仅布尔记录、资源已清 | F01/F02后原审核者定向复核 |

| 2026-11-02 | F01 | completed；固定完整raw无论相邻字符均脱敏，堆栈保留 | f01-red2fail3pass；f01-green5pass；eslint/check通过；证据扫描无完整raw | 原双审定向复核 |
| 2026-11-02 | F02 | completed；共享版本化环境Schema，去重复并保留公开投影/路径检查 | f02-regression4pass；lint/check通过；行为保持重构，不伪造red | 原双审定向复核 |

| 2026-11-02 | 最终复核 | 两轴PASS，自动修复1轮 | 最终lint/check/test/build通过；61pass42skip；定向unit8pass/Docker4pass；真实roundlog无raw；完整Docker22pass/E2E7pass13skip | verify |
| 2026-11-02 | verify | PASS；六E2E终态、22矩阵证据、双审、A1–A7文档及D19提交豁免核对 | verify.md；不重跑绿测试、不重判代码；99基线副本完整 | 完成 |
