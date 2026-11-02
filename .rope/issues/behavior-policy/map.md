# 当前实现定位与历史核查

当前实现（2026-11-02）：permissions冻结宿主授权，resources准备副本/显式挂载，network执行IPv4任务池与例外，decoys/traffic提供默认关闭的部分观察，tasks/environment*.ts管理安装/状态/生命周期，reporting生成独立交付与风险事实。create/candidate/run/recovery/cleanup/gc及CLI/MCP均已接线。B01–B22/E1–E6见tasks/e2e证据；raw拼接脱敏阻断已修复，两轴复核均PASS，见review/verify。

下文为按实施顺序保留的核查历史，“未接入/待实现”只表示该记录当时状态，当前入口以上段和tasks终态为准。

# 实现定位图

本文件记录已核对的实现事实，不表示新增功能已经完成。

- 2026-11-02：项目使用 Node 24、TypeScript、pnpm；检查入口在 `package.json`。
- 2026-11-02：当前目录没有 Git 仓库，不能创建 Git worktree 或提交；协作规则见 `AGENTS.md`，禁止未获明确要求的 commit/push。
- 2026-11-02：需求基线在 `.rope/issues/behavior-policy/grill-decisions.md`，D17 已确认，D3 已被 D4 替代。
- 2026-11-02：项目配置仅从项目 relay-sandbox.yaml 读取，尚无宿主资源授权层；见 `src/config/load.ts`。
- 2026-11-02：严格配置 Schema 包含 network.hostAddresses；当前含义是追加禁止的宿主地址，不是放行例外，不能反转其旧语义；见 `src/config/schema.ts`。
- 2026-11-02：模型档案来自宿主状态目录 profiles，已有可信配置读取模式；见 `src/config/load.ts`。
- 2026-11-02：创建任务时保存配置和摘要、基线、运行时标识；见 `src/tasks/create.ts`。
- 2026-11-02：开发容器为普通用户、CapDrop ALL、缺省无宿主目录挂载，可接收可信资源mount选项，独立任务网络；见 `src/docker/runtime.ts`。
- 2026-11-02：网络入口已支持legacy与default-open两种显式模式；default-open允许外部内网，冻结任务接线前默认仍legacy，见 `src/network/policy.ts`。
- 2026-11-02：网络规则由可信临时辅助容器安装，辅助容器带任务标签；见 `src/network/policy.ts`。
- 2026-11-02：任务服务共享开发容器网络命名空间，文件系统独立，模板来自宿主；见 `src/docker/services.ts`。
- 2026-11-02：开发命令及专用凭据由适配器返回 argv/env，再经 Docker exec 执行；见 `src/agents/development/contract.ts`、`src/tasks/run.ts`。
- 2026-11-02：内核行为采集围绕开发轮次启动与结束，不是持续流量内容审计；见 `src/tasks/run.ts`、`src/audit/collector.ts`。
- 2026-11-02：敏感路径采集为 partial，不观测全部相对路径、系统调用或 getenv；见 `src/audit/collector.ts`。
- 2026-11-02：开发结果仅从工作项目导出，交付通过候选合并与摘要绑定审核；见 `src/tasks/run.ts`、`src/tasks/prepare.ts`、`src/delivery/policy.ts`。
- 2026-11-02：恢复及监督会重新安装网络规则，必须使用任务冻结授权；见 `src/tasks/recovery.ts`。
- 2026-11-02：指标由独立宿主进程采集，清理按任务标签删除容器和网络；见 `src/monitoring/monitor.ts`、`src/tasks/cleanup.ts`。
- 2026-11-02：到期报告与日志清理集中在 `src/tasks/garbage-collection.ts`，新增证据须纳入此处。
- 2026-11-02：报告从宿主事实生成并绑定输出回执；当前只追踪受控项目应用，直接宿主写入需新增影响说明；见 `src/reporting/user-report.ts`。
- 2026-11-02：MCP 工具说明和能力声明已有边界及交付指引，需要与新增权限、诱饵开关和覆盖状态同步；见 `src/mcp/server.ts`、`src/mcp/capabilities.ts`。
- 2026-11-02：现有诱饵仅是测试中写读假 .ssh 文件的夹具，没有产品投放或代理实现；见 `tests/e2e/host-reporting.test.ts`。
- 2026-11-02：运行、现有实测及限制在 `devdocs/usage.md`、`devdocs/implementation-validation.md`；新需求不能直接写成已验证。

- 2026-11-02：新增独立宿主权限类型与严格Schema，诱饵默认关闭、网络grant支持IPv4/CIDR和端口，见 src/permissions/schema.ts、types.ts；仅完成契约，运行时尚未接入。
- 2026-11-02：项目 resourceRequests 仅命名字符串，不能携带授权对象，见 src/config/schema.ts、tests/unit/resource-request.test.ts。

- 2026-11-02：宿主 permissions/<projectId>.yaml 加载与私密 policy.json 冻结在 src/permissions/load.ts、freeze.ts；项目只可申请名称，摘要供后续接线。
- 2026-11-02：新网络规则规划位于 src/network/planner.ts、task-boundaries.ts，保留198.19.0.0/16任务池并检查碰撞；尚待S04真实运行时接线。
- 2026-11-02：资源验证和独立副本位于 src/resources/paths.ts、copy.ts；清理不删除源，S12须传宿主状态目录与原项目保护路径。
- 2026-11-02：诱饵私密清单与独立投放计划在 src/decoys/manifest.ts、placement.ts；禁用不创建清单，默认不改凭据。
- 2026-11-02：scripts/traffic-match.py 返回最小命中事件及覆盖缺口，src/traffic/events.ts验证公开格式；支持原值/percent/Base64，尚未接入真实代理。

- 2026-11-02：S04真实Docker验证公网/私网/同任务、宿主deny/grant、未来任务deny/grant及失败回收；src/docker/runtime.ts第7options、src/network/policy.ts第6network消费冻结策略，S12尚待接线。

- 2026-11-02：src/resources/prepare.ts提供prepareResources与loadPreparedResources，副本复用且不覆盖开发修改；mounts.ts设ReadOnly/rprivate/NonRecursive，真实Docker已验证；不宣称可信宿主并发路径替换已消除。

- 2026-11-02：src/decoys/install.ts调用scripts/decoy-install.py，以dirfd/O_NOFOLLOW/O_EXCL独立安装，默认禁用不连接Docker；真实Docker测试已验证原配置保持，S12未接线。

- 2026-11-02：src/traffic/runtime.ts启动私有mitmproxy sidecar并共享开发网络NS；scripts/traffic-addon.py匹配后最小留证，1MiB×3轮转，真实HTTP/HTTPS/上游信任/清理已验；客户端入口及任务创建仍未接线。
- 2026-11-02：src/audit/redaction.ts脱敏严格fake token原值，保留堆栈；不能据此承诺通用DLP或任意编码脱敏。

- 2026-11-02：src/tasks/environment.ts提供freezeEnvironment（复用快照并绑定双摘要）与prepareEnvironment（资源mount/default-open；无snapshot legacy），真实fs已验；create/candidate未接入。

- 2026-11-02：src/traffic/clients.ts准备纯公开catalog；scripts/traffic-client.py唯一运行分类器，curl7.88.1/wget1.21.3+explicit-ca-file+指定前缀调用已通过真实TLS，未知路径最小gap后原样直通；S12尚未安装入口。

- 2026-11-02：src/traffic/install.ts调用scripts/traffic-install.py在保留/opt/relay-sandbox/audit/<runtimeId>独占安装公共文件；root-owned且普通UID不可写，真实Docker已验；不接收私钥或manifest。

- 2026-11-02：scripts/traffic-python.py为明确urllib.request@3.11.2独立入口，局部SSLContext/opener，真实TLS与降级已验；scripts/build-assets.mjs复制五项受控脚本，字节核对通过。

- 2026-11-02：environment-install.ts组合无覆盖诱饵、sidecar与公共工具，默认off零安装；environment-state.ts持久最小summary/handle且主/检查指针分离，供监督及报告。真实组合已验；创建/候选/运行提示目前接线中。

- 2026-11-02：create/candidate已消费冻结授权、资源和审计安装，真实Docker入口2项通过；run.ts追加trafficGuidance实际当前main工具入口，不修改原需求/全局环境。恢复与清理接线仍待S13。
- 2026-11-02：reporting/traffic-evidence.ts有界nofollow读取最小事件和覆盖缺口，不从零命中推断安全，供S14报告消费。
