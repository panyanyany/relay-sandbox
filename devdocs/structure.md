# 项目结构

从 README 进入运行说明。代码采用单包 TypeScript 模块结构；CLI 和 MCP 共用任务用例。

## 文件树

```text
relay-sandbox/
├── .tasks/                     # 分阶段执行清单、审核和进度日志
├── .rope/                      # 需求包、行为矩阵、真实验收及独立审核记录
├── AGENTS.md                   # 协作规范与文档索引
├── README.md                   # 项目入口与实现状态
├── package.json                # 固定依赖与检查、测试、构建命令
├── pnpm-lock.yaml              # 依赖锁定
├── tsconfig.json               # 严格类型检查
├── tsconfig.build.json         # 构建目录与禁止错误产出
├── eslint.config.js            # 代码检查
├── vitest.config.ts            # 测试超时及并发限制
├── images/
│   ├── Dockerfile              # 三种开发 Agent 与网络辅助工具的固定版本镜像
│   └── traffic.Dockerfile      # 固定mitmproxy版本的私有流量观察镜像
├── scripts/
│   ├── safe-apply.py           # 目录句柄应用、备份、写前日志和摘要核对
│   ├── decoy-install.py        # 无覆盖、拒链接的独立假凭据安装
│   ├── traffic-install.py      # 固定公共工具和证书安全安装
│   ├── traffic-client.py       # curl/wget显式入口与首请求前分类
│   ├── traffic-python.py       # 明确urllib请求入口及局部信任
│   ├── traffic_context.py      # 最小进程声明、内部头编码和严格校验
│   ├── traffic-match.py        # 有界原值/常见编码匹配
│   ├── traffic-addon.py        # 代理写盘前最小筛选和轮转
│   ├── check-length.mjs        # 自有源码及测试少于 500 行检查
│   ├── clean-build.mjs         # 构建前清除旧模块
│   └── build-assets.mjs        # 复制六项受控Python辅助脚本到构建目录
├── src/
│   ├── cli/
│   │   ├── main.ts             # CLI 输入和输出
│   │   └── credentials.ts      # 本机交互终端隐藏输入专用密钥
│   ├── mcp/
│   │   ├── server.ts           # stdio 工具、中文能力说明及参数校验
│   │   ├── relay-setup.ts      # 中转配置查询、设置与检查工具
│   │   ├── capabilities.ts     # 已实现能力与等待方式选择指引
│   │   ├── task-events.ts      # 任务资源、订阅协议、工具和连接关闭入口
│   │   └── task-subscriptions.ts # 连接级初始化、实例隔离、故障状态与监听清理
│   ├── permissions/            # 宿主授权、严格校验及冻结摘要
│   │   └── contract.ts         # 冻结快照结构与序列化容量约定
│   ├── resources/              # 安全路径、独立副本及直接挂载
│   ├── decoys/                 # 可选假凭据清单与无覆盖安装
│   ├── traffic/                # 代理、显式客户端、公共文件安装及入口提示
│   │   └── readiness.ts        # 本地请求验证真实插件剥离内部头
│   ├── config/                 # 严格 YAML 配置、私有档案及摘要
│   │   ├── relay-outcome.ts    # 凭据写入前协议校验及分阶段收尾结果
│   │   ├── relay-credential.ts # 主动提供的密钥保存与本机检查
│   │   ├── relay-template.ts   # 私有模板校验与敏感解析警告保护
│   │   ├── relay-initialize.ts # 首次初始化、目录授权与私有模板导入
│   │   ├── relay-setup.ts      # 项目发现、独立档案与保留注释的配置更新
│   │   ├── relay-check.ts      # 默认本机检查及显式联网小请求
│   │   └── credentials.ts      # 环境注入与本机私有凭据、权限校验
│   ├── projects/
│   │   ├── registry.ts         # 项目注册、实际路径和创建更新时间元数据
│   │   └── lock.ts             # 注册、配置、凭据与模板收尾共用排他锁
│   ├── environments/           # 独立于任务的项目持久环境
│   │   ├── store.ts            # 环境记录及项目排他锁
│   │   ├── acquire.ts          # 边界核验、借用和复用
│   │   ├── workspace.ts        # 跨任务三方同步及基线
│   │   ├── ownership.ts        # 当前借用者校验、恢复和释放
│   │   ├── audit.ts            # 环境诱饵身份与历史安装位置
│   │   ├── idle.ts             # 交付后停止保留或临时销毁
│   │   └── lifecycle.ts        # 停止、重置、删除及TTL候选
│   ├── tasks/                  # 创建、后台派发、开发、收集及交付编排
│   │   ├── create.ts           # 冻结预约、带租约准备及CLI同步创建
│   │   ├── start.ts            # MCP创建后立即派发后台准备
│   │   ├── preparation-control.ts # 跨进程取消标记及文件复制中止信号
│   │   ├── readiness.ts        # 新任务完整就绪校验及旧容器兼容
│   │   ├── recollect.ts        # 仅重试收集失败的产物，不重跑开发模型
│   │   ├── dispatch.ts         # 后台准备、开发及检查进程派发
│   │   ├── environment*.ts     # 冻结资源、独立观察环境、状态和生命周期
│   │   ├── environment-diagnostics.ts # 宿主脱敏原因链及诊断写盘失败留证
│   │   ├── restart.ts          # 恢复与返工共用网络、审计降级及失败收尾
│   │   ├── direct-project.ts   # 直接项目检查前停止、返工启动与最终核对
│   │   ├── prepare.ts          # 隔离合并候选或直接项目事后候选
│   │   ├── check-resources.ts  # 持久环境实际资源冻结与独立检查副本
│   │   ├── candidate.ts        # 最终候选独立检查
│   │   ├── check-and-repair.ts # 有限检查返工
│   │   ├── deliver.ts          # 审查结论绑定与应用
│   │   ├── cleanup.ts          # 停止及资源、工作副本清理
│   │   ├── guidance.ts         # 按任务阶段给出下一步动作
│   │   ├── garbage-collection.ts # 到期资源、报告及指标清理计划
│   │   ├── wait.ts             # 快照版本游标与可取消的有界等待
│   │   ├── lock.ts             # 任务互斥、进程身份及租约
│   │   ├── delivery-baseline.ts # 交付有效基线定位，初始快照留作证据
│   │   ├── resume-workspace.ts  # 恢复三方同步、独立宿主检查点及写入中断保护
│   │   ├── recovery.ts         # 失联协调、恢复与到期回收
│   │   └── supervisor.ts       # 独立监督器循环
│   │   └── artifact-state.ts   # 结果与候选失效、当前收集代次及确认守卫
│   ├── workspace/              # 受控文件读取、完整快照、清单和差异
│   │   ├── sync-operations.ts  # Git 管理目录、工作区替换和宿主基线推进的共享操作
│   │   ├── stable-file.ts      # 固定缓冲区安全读取、流式摘要与共享采集限制
│   │   └── access.ts           # 主项目冻结访问模式、挂载及目录身份核验
│   ├── docker/                 # 运行模板、资源限制、归档、执行及服务
│   │   ├── export-budget.ts    # Docker导出累计字节与条目预算
│   │   ├── archive-links.ts    # 归档内硬链接校验与独立文件展开
│   │   └── preparation-timeout.ts # 仅准备调用链生效的Docker请求超时
│   ├── network/                # 宿主地址探测、任务网络规则
│   ├── agents/
│   │   ├── host/               # 宿主接入、审查契约及严格审核 Schema
│   │   └── development/        # 三种独立适配器及固定注册表
│   ├── reporting/             # 生成用户报告与校验实际最终输出
│   │   └── runtime-diagnostics.ts # 事件证据、覆盖缺口及因果边界文案
│   ├── monitoring/            # 独立指标进程、采样、状态、日志轮转
│   │   ├── runtime-events.ts   # Docker最小事件流、断流诊断及重连
│   │   ├── cgroup.ts           # 本机容器身份核对及内存峰值、OOM计数
│   │   ├── termination.ts      # 固定来源的停止请求与结果留证
│   │   └── pressure.ts         # 持续高内存提醒、快照事实及发布
│   ├── audit/                  # bpftrace 部分采集、脱敏与覆盖报告
│   ├── delivery/               # 合并、检查事实、放行策略、应用与故障诊断
│   └── storage/                # 原子 JSON、JSONL、摘要及清理错误保留
├── tests/
│   ├── unit/                   # 配置、交付、文件、路径攻击、等待、MCP 握手及跨进程事件
│   │   ├── resume-workspace.test.ts # 恢复合并、有效基线、轻量同步及故障现场
│   │   ├── recovery-boundaries.test.ts # 恢复互斥、统一阻断及迟到派发身份
│   │   ├── exclusive-json.test.ts # 指标采集器排他锁原子发布与竞争
│   │   └── resume-dispatch.test.ts # 后台恢复派发、交接和失败记录
│   ├── integration/            # 真实 Docker、服务网络、内核采集及恢复
│   ├── e2e/                    # 三种实际 Agent 的假中转站交付、有限返工、显式真实接口及恶意代码审核测试
│   ├── helpers/               # 真实宿主 CLI 会话与输出捕获
│   └── fixtures/               # 假凭据协议服务，不调用真实计费 API
├── devdocs/                    # 功能说明、需求、方案与验证范围
│   └── terminal-maintenance.md # 终端故障分类、取消等待与停止监测
│   ├── artifact-recovery.md    # 产物硬链接导出与失败重收集
│   ├── persistent-environments.md # 默认保留、同步及环境生命周期
│   ├── task-events.md          # 任务资源订阅及宿主续接边界
│   ├── relay-setup.md          # MCP中转配置与本机隐藏凭据录入
│   ├── maintenance.md          # 维护修复契约、错误示范及回归验证
│   ├── project-access.md       # 默认直接挂载、可选隔离副本与事后检查
│   └── traffic-correlation.md  # 诱饵命中关联、进程声明及证据边界
└── references/                 # 可公开外部方案及资料
```

`dist/`、`node_modules/`、`.local/` 为忽略的本机目录。构建入口为 `dist/src/cli/main.js`，应用辅助程序位于 `dist/scripts/safe-apply.py`。运行状态默认保存在用户的 `~/.local/share/relay-sandbox`，不放进原项目。

本机专用说明保存在 `.local/devdocs/`，入口为 `index.md`。新增或移动模块时同步本文件和 AGENTS 索引。

## 行为策略执行记录

`.rope/routes.md` 保存已确认的host-managed共享模式，不执行Git操作。`.rope/issues/behavior-policy/` 保存完整需求包：`grill-decisions.md` 为确认台账，`prd.md` 为需求和架构约束，`tasks.md` 为小切片/矩阵/进度，`e2e.md` 为实际入口验收，`review.md` 为独立审核记录。状态按这些文件的当前记录判断。

`devdocs/behavior-policy.md` 提供宿主授权、网络、资源和可选诱饵配置。`references/traffic-audit.md` 保存外部证据范围。私密原值、基线和实测过程保存在忽略的 `.local/`，不得作为公开报告正文。

## 独立终端模块

```text
src/terminal/
├── command.ts                # 默认逐行入口与 JSONL 命令装配
├── line-input.ts             # 逐行读取及共享命令校验
├── line-output.ts            # 真实事件呈现与完整消息去重
├── line-session.ts           # 复用共享 JSONL 的多轮输入和观察
└── session.ts                # V2 开发身份和旧 V1 元数据兼容
src/sessions/
├── schema.ts                 # 固定项目、Agent 和原生会话身份
├── startup-context.ts        # 授权项目只读启动及专属资源登记
├── startup-close.ts          # 只清理当前入口登记的资源
├── activation.ts             # 首请求和正式身份原子保存
├── requests.ts / commands.ts # 结构化请求校验与统一命令路由
├── capabilities.ts           # 技能发现与执行的独立能力契约
├── environment.ts            # 正式身份保存后的环境准备
├── profile.ts                # 冻结开发档案及最小环境
├── operation.ts / state.ts   # 原子准入、状态和待审版本
├── backend-lifecycle.ts      # Docker退出事件与持久中断传播
├── worker.ts / worker-api.ts # 独占后台、私有控制 RPC和逐请求保存
├── dispatch.ts               # 后台派发与 PID 就绪核对
├── runtime.ts / runtime-driver.ts # 审计、结构化Agent、审查和停止装配
├── readiness.ts              # 原生上下文与实际后台就绪核对
├── events.ts / event-store.ts # 真实语义事件、游标和轮转缺口
├── audit.ts / evidence-index.ts # 连续审计及证据索引
├── json-command.ts / json-protocol.ts # 终端和网页共用请求、事件及错误阶段
├── stop.ts / stop-intent.ts   # 显式停止意图及协调边界
├── recovery.ts               # 旧进程死亡证明与同上下文恢复
└── review/
    ├── evidence.ts / snapshot.ts # 全任务冻结及固定代码日志
    ├── config.ts / cli.ts       # 独立可信配置与受限审查 CLI
    ├── executor.ts              # 代码与行为两轴严格结果
    ├── checks.ts / check-facts.ts # 隔离检查和固定检查事实
    └── report.ts / state.ts     # 报告、固定补审及待审查询
src/agents/sessions/
├── contract.ts               # 原生启动与协议消息适配契约
├── codex-driver.ts / codex-gateway.ts # app-server上下文及轮次控制
├── codex-rpc.ts / codex-skills.ts # RPC生命周期与原生技能输入
├── claude-driver.ts / claude-code.ts # print结构化执行与真实消息解析
├── claude-readiness.ts / claude-skills.ts # 无提示词就绪及实际初始化技能
├── opencode-driver.ts / opencode-bridge.ts # serve请求、同ID恢复和结果校验
└── opencode-skills.ts        # 原生技能列表及不支持调用的明确结果
src/docker/interactive.ts    # TTY、stdio、resize 和真实退出码
src/cli/session-commands.ts  # 内部 worker、状态、事件、停止与恢复
src/cli/review-command.ts    # 会话审查和旧任务 --file 语义分流
src/tasks/check-runtime.ts   # 旧交付与独立审查共用检查环境收尾
tests/unit/session-*.test.ts # 会话各层及失败边界回归
tests/unit/terminal-*.test.ts # 逐行输入、共享JSONL和实际 CLI 协议回归
```

独立终端直连需求对齐台账：`.rope/issues/direct-terminal/grill-decisions.md`。需求已确认；实现状态见正式任务包。

终端直连 shape 记录：`.rope/issues/direct-terminal/map.md` 保存带日期的代码事实；`slice-outline.md` 保存已确认切片和依赖图，正式执行包见下方。

当前统一输入正式任务包（U01–U23已实施，产品终验与发布待完成；旧原生失败保留为历史）：

```text
.rope/issues/direct-terminal/
├── grill-decisions.md # D1–D25 已确认需求及共享理解
├── map.md             # 带日期的代码事实与边界
├── capabilities.md    # 实际CLI结构化及历史原生探针结果与限制
├── slice-outline.md   # 已确认的切片提纲
├── prd.md             # 当前统一输入交付摘要、架构约束与授权
├── prd-native-history.md # 已替代原生界面合同原文
├── tasks.md           # 首轮25片、17波次及历史审核进度
├── revision-tasks.md  # 原生生命周期修订历史及R01失败
├── unified-input-tasks.md # 统一输入36实施单元、23波次及审核进度
├── e2e.md             # UE真实验收与旧原生终态及未覆盖范围
├── review.md          # 双审裁定、两轮修复与升级记录
└── verify.md          # 文档核对BLOCKED及后续阻塞
```

任务包同时记录实施和剩余验收；文件存在不代表真实模型及发布验收已经通过。

```text
scripts/probe-native-sessions.ts         # 隔离假中转的原生准入探针
scripts/probe-native-lifecycle.ts        # Claude原生命令绕过准入的隔离复现
tests/unit/native-session-probe.test.ts # 阻断证据分类回归
tests/unit/native-lifecycle-probe.test.ts # 本地副作用与生命周期证据分类回归
```

```text
scripts/probe-structured-sessions.ts     # 三种实际CLI的结构化创建与恢复探针
scripts/structured-probe-support.ts     # 隔离假接口和探针资源管理
tests/unit/structured-session-probe.test.ts # 结构化探针证据分类回归
```

终端会话故障与等待策略见 [终端维护边界](terminal-maintenance.md)。
