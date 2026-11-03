# 运行中转沙箱

使用 Linux、Node.js 24、pnpm 10 和可访问的 Docker Engine。先准备专用中转站档案，再注册项目。宿主账号凭据不会自动复制到任务中。

## 安装和构建

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm check && pnpm test
pnpm build
docker build -t relay-sandbox-dev:0.1.0 -f images/Dockerfile .
docker image inspect relay-sandbox-dev:0.1.0 --format '{{.Id}}'
node dist/src/cli/main.js doctor
```

将最后得到的不可变镜像 ID 填入模型档案。Docker 社区客户端 dockerode 固定使用 API v1.44，要求服务端支持此版本。当前工具提供 CLI 和 stdio MCP，没有网站，不需要重启网站。

## 配置模型档案

首次使用优先让宿主 AI 调用配置 MCP 工具，按[中转配置](relay-setup.md)完成项目选择、地址和模型设置及本机隐藏凭据录入。以下 YAML 方法适用于手动管理档案。

默认状态目录为 `~/.local/share/relay-sandbox`。可用全局参数 `--home <目录>` 指定其他位置。创建 `profiles/relay-default.yaml`，限制目录和文件权限：

```yaml
endpoint: https://relay.example/v1
model: your-model
apiKeyEnv: RELAY_DEVELOPMENT_KEY
protocol: responses
image: sha256:<镜像的64位摘要>
networkImage: sha256:<相同镜像的64位摘要>
```

用安全的环境注入方式提供 `RELAY_DEVELOPMENT_KEY`，或执行配置查询返回的 `credential-set` 命令隐藏录入本机私有凭据。环境变量优先，私有文件其次。档案保存环境变量名称，不保存密钥值；不要把真实密钥写进项目、命令参数或公开文档。任务创建时冻结档案及项目配置，后续修改只影响新任务。

| 开发 Agent  | `type`        | 档案 `protocol`     |
| ----------- | ------------- | ------------------- |
| Codex       | `codex`       | `responses`         |
| Claude Code | `claude-code` | `anthropic`         |
| OpenCode    | `opencode`    | `openai-compatible` |

项目根目录的 `relay-sandbox.yaml` 支持：

```yaml
version: 1
project:
  exclude: ["private/**", ".env.local"]
hostAgent:
  type: codex
developmentAgent:
  type: codex
  profile: relay-default
delivery:
  aiReview: true
  checks:
    - name: unit
      argv: ["npm", "test"]
  maxRepairRounds: 2
lifecycle:
  taskTimeoutMinutes: 120
  leaseSeconds: 30
  interruptedRetentionHours: 24
resources:
  cpus: 2
  memoryMiB: 4096
  pids: 256
  maxOutputBytes: 1048576
network:
  hostAddresses: [] # 额外 NAT 入站地址；在此显式填写 IPv4 地址
audit:
  reportRetentionDays: 7
```

默认仅启用宿主 AI 审查，默认 `checks: []`。完整复制项目，包括 Git 忽略内容；只按显式排除规则过滤。符号链接保留为链接，不读取外部目标。普通仓库的 `.git` 会复制，但不会作为交付修改应用；worktree、链接 `.git` 和外部 Git 引用须显式排除或改用自包含仓库。

## 选择原项目访问模式

默认使用独立副本。需要立即修改原项目时，在宿主状态目录的 `permissions/<projectId>.yaml` 配置 `project: { mode: direct }` 后创建新任务。此模式不支持非空 `project.exclude`，审核拒绝不撤销已有修改；`apply_task` 只确认事后检查，不回写。权限、返工和报告字段见[项目访问方式](project-access.md)。

## 委派、审核和应用

```sh
node dist/src/cli/main.js register demo /path/to/project
node dist/src/cli/main.js start demo '完成指定开发任务' --wait
node dist/src/cli/main.js status <任务ID>
node dist/src/cli/main.js logs <任务ID> --offset 0
node dist/src/cli/main.js result <任务ID>
node dist/src/cli/main.js prepare <任务ID>
```

`start` 默认在后台执行；`--wait` 等待本轮结束。`prepare` 三方合并当前原项目、初始基线及开发结果，生成 `candidate/` 和 `apply-plan.json`，在新的隔离容器中执行配置的检查，保留开发工作区。失败检查会触发有限返工；运行环境错误立即暂停。冲突返回路径清单，由宿主编辑任务目录的 `candidate/`；完成后运行 `check-candidate <任务ID>`，重新检查并生成最终应用计划。

宿主 Agent 阅读候选、差异和证据后提交结论。摘要从准备结果取得：

```sh
node dist/src/cli/main.js review <任务ID> --file /path/to/review.json
node dist/src/cli/main.js apply <任务ID>
node dist/src/cli/main.js cleanup <任务ID>
```

审核 JSON 使用 `schemaVersion: 1`，包含 `taskId`、`artifactDigest`、`configDigest`、`verdict`、`summary`、`findings`。`verdict` 为 `approve`、`reject` 或 `needs_attention`；后两项阻止启用 AI 审查时的自动交付。完整格式见[结构化审核](review.md)。旧的 `accepted/reason` 和 CLI 摘要参数已移除，旧批准记录需要重新审核。产物变化后旧结论失效。全部检查关闭时，`prepare` 返回 ready，可直接 `apply`，结果注明未执行交付检查。应用锁为协作锁，应用期间暂停外部编辑器或其他非协作写入。应用前再次核对每个目标的当前摘要；备份在 `backup/files/`，应用日志在 `backup/applied.jsonl`。应用失败立即停止。用 `inspect-apply <任务ID>` 查看各路径为 original、applied 或 diverged，再按备份和 prepared/applied 日志人工处理；不会自动重放或覆盖后续用户修改。

正常返工使用 `rework <任务ID> '<修改要求>'`，沿用任务工作区。`cancel` 尝试停止主容器和全部任务标签容器；全部停止成功才更新停止状态。`cleanup` 删除本任务服务、开发容器、观察代理和网络，保留宿主报告及备份。

## 接入宿主 Agent

运行 `host-config <项目标识>`，Codex 片段会为本服务设置工具授权和档案环境变量转发，合入前确认信任该本地服务；按照项目 `hostAgent.type` 输出 Codex TOML、Claude Code JSON 或 OpenCode JSON 的 MCP 配置片段。手动合入现有配置，工具不会覆盖用户配置。生成配置基于当前构建目录；移动安装目录后重新生成。

MCP 命令为 `node <绝对构建目录>/src/cli/main.js --home <状态目录> mcp`。工具包括 `get_capabilities`、`wait_task`、`get_telemetry`、`get_audit`、`get_delivery_plan`、`report_task`、`start_task`、`run_task`、`get_task`、`get_result`、`prepare_delivery`、`review_task`、`apply_task`、`cancel_task`、`cleanup_task` 、`start_service`、`check_candidate`、`resume_task` 和 `read_artifact`。`start_task` 只创建环境；开发由 `run_task`、`prepare_delivery`、`check_candidate` 派发后台宿主进程并立即返回，可用 `wait_task` 等待或用 `get_task` 查询。排队状态 queued 会立即使旧审查失效。首次配置可由宿主 AI 在用户明确授权后通过 `initialize_relay` 注册项目目录；任务仍只接收已注册标识，MCP 不接收挂载或 Docker 权限参数。

## 让宿主 Agent 选择等待方式

MCP 初始化说明会提示宿主先调用 `get_capabilities`。每个工具都有中文用途和步骤说明。能力返回包含后台执行、查询、有界等待、事件、审核、部分审计和用户通知限制。宿主按已声明的能力及客户端调用时限选择方式。

1. 调用 `get_task`，取得当前状态及 `revision`。
2. 客户端允许等待时调用 `wait_task`：

   ```json
   {
     "id": "任务ID",
     "afterRevision": "get_task返回的revision",
     "timeoutSeconds": 25
   }
   ```

3. 返回包含 `task`、`revision`、`reason`。`changed` 表示任务快照变化，同一状态内的检查或风险更新也会返回；按当前步骤判断是否需要继续等待。`timeout` 表示本次等待到期，后台任务继续运行。后续调用使用返回的新游标。
4. 客户端调用时限短时调低 `timeoutSeconds`，或约每 5 秒调用 `get_task`。客户端时限应大于等待时长并留出通信余量。

等待默认 25 秒，支持 1–55 秒。取消调用只结束等待，要停止任务使用 `cancel_task`。服务端每 250 毫秒读取任务快照，期间不调用模型、不占用任务操作锁。游标是快照内容摘要，用于检测最新变化，不是事件日志；短暂的中间状态可能合并，不提供逐事件重放。

当前支持任务资源订阅和面向已连接订阅者的更新通知。客户端确认可消费通知并续接时，可选择事件方式；接入步骤和限制见[任务事件](task-events.md)。`nativeMcpTasks`、`hostWakeup` 仍不支持。普通 MCP 通知不等于宿主 AI 自动唤醒；未验证客户端续接时继续使用有界等待或查询。

能力声明区分报告生成与用户输出。结束时调用 `report_task`，输出绑定事实的 `reportId`、`userMessage`。详细流程及实际输出校验见[异常上报](user-reporting.md)。定时指标和资源回收见[指标与清理](observability.md)。

## 启动同任务服务

宿主预先创建 `services/web.yaml`：

```yaml
image: sha256:<支持普通用户运行的镜像摘要>
argv: ["python3", "-m", "http.server", "8080"]
```

运行 `service-start <任务ID> web`。服务通过 localhost 与开发容器通信，共享任务网络策略，不发布宿主端口。服务使用 UID 1000 和独立文件系统，模板须支持此用户；当前不提供数据库卷和凭据模板。资源限制按容器计算，多个服务没有任务总量配额。

## 查看审计与已知限制

审计自动尝试使用宿主 `sudo -n bpftrace`，按开发容器 cgroup v2 采集。不要为开发容器增加采集权限。未满足条件时报告 unavailable；成功启动仍标为 partial。报告位于任务目录 `audit.json`、`audit-round-N.json` 和宿主独立保存的 `audit-events.jsonl`。

`get_result` 返回聚合审计摘要，完整事件使用 `get_audit` 分页读取。宿主应用计划由 `get_result.applicationPlan` 或 `get_delivery_plan` 提供，不在项目候选目录中。

当前覆盖 open/openat、unlink/unlinkat、rename/renameat/renameat2 的敏感路径元数据，不记录文件内容。失败尝试和成功调用分开记录；成功 open 不等于已修改内容。尚不覆盖所有系统调用、继承描述符、mmap、服务容器、后台间歇或完整相对路径解析，也不承诺观测进程内存 getenv。审计异常和可疑行为只提醒，不单独阻止交付。

新任务默认允许公网、外部内网和同任务服务，拒绝宿主接口、探测到的公网出口及其他任务，关闭 IPv6。宿主冻结授权可按 IPv4/CIDR、协议和端口放行例外；没有策略快照的旧任务仍使用旧的私网默认拒绝规则。创建任务依赖 `https://api.ipify.org` 探测宿主出口，失败即停止。额外 NAT 入站地址使用 `network.hostAddresses` 登记。监督器运行时会重新探测并原子更新策略；刷新失败停止任务。未运行监督器时，地址变更不会自动同步。复杂路由和其他 NAT 入站别名仍需部署者核对，不把基本测试视作完整网络边界验收。

磁盘硬限额尚未启用。单文件导出大于 256 MiB 时明确报错；不会静默忽略。空目录参与复制、摘要和交付；目录与普通文件类型替换也会检查和应用。日志按配置截断并持续排空，使用轮次和字节游标读取。

## 运行监督器并恢复任务

在独立进程管理器或单独终端运行：

```sh
node dist/src/cli/main.js supervise --interval 5
```

`--once` 只协调一次。监督器通过操作租约、进程启动标识及 Docker 实际状态检测失联。默认租约 30 秒，默认轮询 5 秒；在 Docker 与网络探测及时响应时，失联检测上界约为租约加一轮轮询，多任务顺序协调会增加耗时。轮询并非实时硬保证。部署后须让监督器持续运行；CLI 不擅自安装系统服务。

监督器尝试停止失联任务的全部任务标签容器及登记的主容器，包括观察代理。全部停止成功后才记为 interrupted，并按 `interruptedRetentionHours` 保留工作区。停止失败保留原状态，记录错误和警告并抛出异常，不能据此认为进程已停止。运行 `resume <任务ID>` 恢复环境，先回收旧代理和旧进程，再用冻结授权重装网络规则，成功后才允许 `run` 或 `rework`。恢复沿用原诱饵值，生成新的观察运行目录和证书；不读取最新宿主授权，不恢复进程内存和服务进程，也不自动重放部分应用。故障后先核对 `inspect-apply` 和备份，确定处理方式。

`cleanup` 删除开发、检查、服务容器、任务网络和工作副本，保留备份与报告。监督器也按 `finishedRetentionHours` 清理结束、失败或停止的任务资源，并按 `reportRetentionDays` 清理已关闭任务的审计、用户报告及轮次/后台日志；应用备份和任务元数据不会自动删除。Docker 不可用时监督器退出并报告错误，由外部进程管理器告警与重启；不会把失败记为已清理。

## 显式运行真实模型测试

先确保 Docker 镜像已构建、宿主可执行审计命令，并通过安全的环境注入方式设置 `RELAY_LIVE_KEY`。使用有测试预算的 DeepSeek API 凭据，然后执行：

```sh
RELAY_LIVE_TEST=1 pnpm exec vitest run tests/e2e/live-provider.test.ts
```

该测试会产生实际 API 用量，依次测试三种开发 Agent。它只发送临时创建的示例项目，不读取 Codex 凭据配置。默认 `pnpm test` 会跳过真实接口测试。测试使用 `deepseek-flash` 及三种固定协议地址，检查代码修复、独立测试、宿主程序审查和应用；不包含宿主模型 MCP 会话。凭据只在内存及容器受控环境中使用，测试结束清理任务资源。

## 配置宿主资源和行为观察

任务创建前阅读[行为策略](behavior-policy.md)，在状态目录配置 `permissions/<projectId>.yaml`。项目只能通过 `resourceRequests` 申请已授权名称，不能在项目配置或MCP调用中直接声明宿主路径/网络授权。配置在创建时冻结，修改只影响新任务。

新任务默认允许外部内网；宿主与其他任务默认拒绝。额外目录默认独立副本，直接可写共享会立即影响宿主，用户应按需要明确授权。诱饵默认关闭；开启后还需明确选择已验证客户端组合并使用显式工具入口，空列表不会自动启用所有工具。查看 `get_capabilities` 和 `get_result.policy` 了解能力及覆盖状态。

构建可选流量观察镜像时使用仓库根作为构建上下文：

```sh
docker build -f images/traffic.Dockerfile -t relay-sandbox-traffic:0.1.0 .
```

代理基础镜像固定为 mitmproxy 12.3.1 的镜像摘要。开发镜像实测 curl 7.88.1、GNU Wget 1.21.3 和 Python 3.11.2；受控 Python 入口仅支持 urllib.request@3.11.2。更新镜像或工具版本后，须重新验证完整组合，不能直接沿用已验证声明。代理和公共工具安装失败不会关闭真实TLS验证，也不会放宽强制网络隔离；报告留下覆盖缺口。操作者须独立运行 `supervise` 才会定期检测代理退出。恢复使用原授权和诱饵值，创建新的运行目录及证书。

## 查看通信命中的进程线索

已验证的显式审计入口可将最小进程声明与命中关联。升级时须重建观察镜像和 CLI，并创建新的观察环境；完整步骤、字段及不可信声明边界见[调用关联](traffic-correlation.md)。

## 复用已安装的软件

新任务默认使用项目持久环境，交付完成后停止并保留。`cleanup` 不删除持久环境；下一任务重新同步项目并借用同一容器。重置、TTL 和临时模式配置见[持久环境](persistent-environments.md)。旧任务没有环境编号时继续使用原任务级回收规则。
