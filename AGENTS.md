# 项目协作规范

## 文档规范

### 选择保存位置
文档默认可公开。按内容用途和适用范围选择目录：

| 内容 | 位置 |
| --- | --- |
| 适用于不同环境的项目开发与运维说明 | `devdocs/` |
| 可公开的外部参考资料 | `references/` |
| 本机专用或私有的项目说明 | `.local/devdocs/` |
| 私有外部参考资料 | `.local/references/` |

`.local/` 不进入版本控制。

### 编写内容
- 项目开发文档使用简体中文，说明当前实现和已验证的方法。
- 遵循 GOV.UK 内容设计指南，结合 ASD-STE100 的清晰表达原则。按读者任务组织内容，先写操作，使用短句和一致术语。具体要求见 [文档写作规范](devdocs/writing.md)。

### 更新索引与文件树
- 文档更新时，更新本文件中的相关索引。用一句话或几个关键词描述。
- 项目文件结构变化时，更新 [项目结构](devdocs/structure.md)。文件树使用中文说明。

### 文档索引

| 文档 | 内容 |
| --- | --- |
| [项目入口](README.md) | 中转沙箱名称、项目目标、可配置交付检查及全关闭时直接应用、当前状态与阅读顺序 |
| [开发任务](.tasks/2026-11-02-relay-sandbox-development.md) | T01–T13 与交付子步骤、文件少于 500 行、错误规则、审核日志及分阶段 devdocs 收尾；开发版已实现，专项验收进行中 |
| [开发方案](devdocs/development-plan.md) | Docker 首选路线、语言建议、分离的 Agent/交付契约、错误处理及稳定化边界；实现状态见验证记录 |
| [需求](devdocs/requirements.md) | 使用流程、完整副本与配置排除、同任务服务互通及保护边界、中断后限期保留、重点审计及定时回溯清理 |
| [架构草案](devdocs/architecture.md) | 执行职责、已确认的访问边界与交付建议；开发版实现及剩余验证见实现验证记录 |
| [验证计划](devdocs/validation.md) | 功能、访问、交付及内层行为审计验收、候选专项检查；中断恢复和到期回收后置；已部分实测，完整专项待验收 |
| [决策与待确认事项](devdocs/decisions.md) | 需求对齐记录、整项目复制与配置排除、默认隔离及可配置直接挂载、网络边界、重点审计、可配置交付检查、失败暂停交付、审计未知结果提醒、已确认需求基线、中文名、双侧 Agent 配置、稳定化延期及定时汇总清理 |
| [项目调研](references/projects.md) | 11 个仓库的特性、默认行为、需求适配与验证项 |
| [需求对照表](references/capability-matrix.md) | R01–R10 比较、网络边界、试配路线；新增 R11 审计待核查 |
| [资料索引](references/sources.md) | 官方资料、原帖、11 个固定提交与证据范围 |
| [文档写作规范](devdocs/writing.md) | 按任务组织内容、术语与验证状态写法 |
| [行为策略对齐](.rope/issues/behavior-policy/grill-decisions.md) | 阻断与事后审查的已确认需求；保留历史对齐记录 |
| [行为策略实现定位](.rope/issues/behavior-policy/map.md) | 已核对的模块职责、接口差异与现有验证入口 |
| [行为策略开发方案](.rope/issues/behavior-policy/prd.md) | 新网络边界、宿主授权、可选诱饵及兼容通信审计；已实施，证据见任务与验收记录 |
| [行为策略任务](.rope/issues/behavior-policy/tasks.md) | B01–B22、42 个实施切片及 2 个修复子片；原执行包双审和 verify 通过 |
| [行为策略真实验收](.rope/issues/behavior-policy/e2e.md) | 网络、授权冻结、目录、TLS/诱饵、真实宿主报告及资源故障六组；E1–E6 已记录通过证据 |
| [行为策略切片提纲](.rope/issues/behavior-policy/slice-outline.md) | 历史切片提纲；已确认并形成正式执行包 |
| [行为策略方案状态](.rope/issues/behavior-policy/shape-notes.md) | 历史环境基线、实现边界及已解决的 TLS 兼容限制 |
| [通信审计资料](references/traffic-audit.md) | 官方 TLS 透传示例、首个请求失败与检测证据边界 |
| [Rope 执行路由](.rope/routes.md) | host-managed、检查入口、文档路由及 Git 显式授权规则 |
| [异常上报](devdocs/user-reporting.md) | 宿主上报流程、准备与输出回执、真实会话验证方法 |
| [指标与清理](devdocs/observability.md) | 独立采样、采集器原子锁发布、CPU/内存等指标、137 停止证据、Docker 事件与重启保留摘要、覆盖缺口上报、持续高内存提醒、轮转保留及资源回收 |
| [结构化审核](devdocs/review.md) | 严格审核 Schema、CLI/MCP 提交、分类与恶意中转站测试 |
| [行为策略](devdocs/behavior-policy.md) | 宿主授权、冻结网络例外、目录模式、默认关闭诱饵、显式工具与覆盖边界 |
| [中转配置](devdocs/relay-setup.md) | 对话初始化、私有文件模板与导入、目录授权与项目元数据、完整操作锁、凭据隔离与覆盖提示、主动提供密钥直配、文件与隐藏录入任选、模板基线冲突及分阶段配置检查 |
| [任务事件](devdocs/task-events.md) | MCP 资源订阅、并发初始化、订阅健康查询、故障诊断、断线清理、后台环境准备与恢复、取消与清理互斥、租约交接及派发失败定位与宿主续接边界 |
| [运行说明](devdocs/usage.md) | 安装构建、模型档案、CLI/MCP 能力发现、有界等待、交付、服务、真实模型测试、部分审计及限制 |
| [实现验证记录](devdocs/implementation-validation.md) | 实际测试、三种开发 Agent 联调、Codex 宿主上报、指标崩溃留证、维护性修复回归、诱饵调用关联、项目访问模式、REV-001–REV-005 回归、持久环境验收、PENV-001–PENV-004 修复回归、任务事件验证、EVT-001–EVT-003 回归、中转配置闭环、首次配置与项目元数据、SETUP-001–SETUP-006 修复回归、主动密钥直配与双录入入口、CRED-001–CRED-004 修复、后台环境准备与真实Docker就绪验收、137 留证与内存压力、硬链接导出及产物重收集、MAINT-001–MAINT-004 修复验证、中断恢复三方同步、RSYNC 修复与剩余验收 |
| [持久环境](devdocs/persistent-environments.md) | 项目环境默认保留、跨任务与中断恢复三方同步、无 Git 项目、独立检查点、有效交付基线、无变化轻量同步与写入失败保护、TTL、资源检查快照、审计降级、错误链及显式重置删除 |
| [项目访问方式](devdocs/project-access.md) | 默认隔离、宿主显式直接挂载、停止后检查、采集限制与恢复清理 |
| [调用关联](devdocs/traffic-correlation.md) | 显式入口进程声明、调用与请求编号、内部头剥离、功能就绪探针、证据边界及真实验收 |
| [维护性修复](devdocs/maintenance.md) | 上报版本、授权容量、证据预算、环境收尾与脱敏诊断的契约及回归验证 |
| [产物收集恢复](devdocs/artifact-recovery.md) | 硬链接安全导出、累计容量与条目预算、收集失败单独重试、候选代次及阶段诊断 |
| [项目结构](devdocs/structure.md) | 目录用途与中文文件树 |

## 开发规范
- 编码完毕后，补单元测试，运行 `pnpm lint && pnpm check && pnpm test` 并修复
- 除非用户明确要求，否则不要自动执行 git commit 或 git push
- 要有中文注释: 函数、关键步骤等
- 优先使用行业内的成熟方案，避免造轮子
  - 遇到问题，先去 AGENTS.md 找已有实现，或者在项目内找
- 完成需求后重新构建并重启网站
- 操作本机前，阅读 .local/devdocs/index.md 及相关文档（若存在），并核对实际环境。

## AI提示词编写规范
- 以正向引导为主，负面清单仅兜底
- 保持简单、准确
