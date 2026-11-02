# 项目调研与适配判断

核查日期：2026-11-02。先用[需求对照表](capability-matrix.md)缩小试配范围，再查本文的具体能力、默认行为和验证项。范围为 **11 个独立仓库**；BoxLite 与其 MCP 桥、Hullwork Sandbox 与 Site 分别计数。

本文依据官方文档和固定提交中的部分源文件。文档声明、代码观察与本项目的适配判断分别标注。**全部候选尚未在本项目安装或实测**，没有候选被认定完整通过 R01–R10。未找到某项能力，不等于证明它不存在。固定提交与证据范围见[资料索引](sources.md)。

## 先辨认各项目负责的环节

| # | 项目 | 可复用的环节 | 与需求最相关的限制 |
| --- | --- | --- | --- |
| 1 | Magpie | 模型协议转换、路由、Agent 配置 | 会发现凭据、修改配置；不提供开发进程隔离 |
| 2 | Agent Sandbox / abx | CLI、MCP、provider、后台任务 | 默认云后端；本地 OpenSandbox 需要另装 provider 与服务 |
| 3 | OpenSandbox | Docker / Kubernetes 沙箱、CLI、MCP、网络与凭据组件 | MCP 只覆盖部分底层能力；需明确网络执行模式 |
| 4 | PAL MCP Server | 多模型调用、`clink` CLI 委派 | 默认 Codex 参数绕过自身沙箱；子进程继承宿主环境 |
| 5 | AIO Sandbox | 内置 Codex、容器内终端与文件接口 | 面向可信开发的默认配置需收紧；生命周期由外层管理 |
| 6 | BoxLite | OCI 镜像运行于 microVM、资源与生命周期 API | Linux 需要 KVM；网络和宿主文件策略需单独配置 |
| 7 | BoxLite MCP | 通用 VM 操作、命令执行、复制文件 | 宿主路径入口需约束；接口未覆盖新版运行时的全部策略 |
| 8 | Hullwork Sandbox | Kubernetes + gVisor、会话 MCP、检查点和制品 | 部署组件较多；运行时停止后工作区与对象仍可保留 |
| 9 | Hullwork Site | 网站构建、发布、HTTP 内容验证 | 不承担完整开发 Agent 隔离；属于可选的后续发布环节 |
| 10 | Octo Agent | 自定义模型、非交互开发执行 | 内置沙箱主要限制终端子进程；需整个 Agent 进入外部运行时 |
| 11 | NVIDIA OpenShell | Agent 执行、文件和网络策略、凭据替换 | 内核能力有前提；自定义中转站须建立专用 provider profile |

## 1. Magpie：按需解决模型接口兼容

**定位与证据。** 官方 README 描述 OpenAI Chat Completions、Responses、Anthropic 和 Gemini 等协议转换，以及流式输出、工具调用、模型路由和 Agent 配置管理。它能辅助 R02；网关自身放进容器不能覆盖开发 Agent 的 R03。[来源：README][magpie-readme]。

**可复用能力。** 原生 Agent 接口与目标中转站协议不一致时，可评估协议转换。路由组、账号切换和故障转移可提高调用可用性，但本需求指定中转站与模型，应先固定单一路由，确认失败时不会换到另一个供应方。文档中的脱敏默认关闭；启用后会替换请求中的敏感值，并在响应及工具参数中恢复。该机制不能约束文件工具和 shell 的读取范围。[来源：README][magpie-readme]。

**配置与凭据边界。** 文档提供订阅凭据发现及 Agent 配置切换。代码观察：Codex 适配器会写入所解析 Codex HOME 下的 `config.toml`，设置 provider 和接口；相关路径还涉及认证配置。文档提供 `magpie accounts discovery off` 和 `MAGPIE_NO_ACCOUNTS=1` 关闭账号发现。若采用，应使用专用 HOME、配置和中转站凭据，避免改动宿主机官方 Codex。[来源：README][magpie-readme]、[Codex 适配器][magpie-codex]。

**适配判断。** 先测试内层 Agent 能否直接连接中转站。只有确认存在协议缺口时，再增加独立网关；不要先引入一层可发现宿主凭据的配置管理。

**优先验证。** F02 检查实际上游、模型、流式工具调用及错误响应；I02–I04 检查无关凭据和配置写入；连接失败时的路由行为纳入 F02。脱敏后工具参数仍应接受交付审核。

## 2. Agent Sandbox / abx：已有委派和后台任务入口

**定位与部署。** abx 提供 CLI、MCP 和 provider 扩展。默认 provider 为 Alibaba Cloud Express。官方 provider 目录同时提供连接本地 OpenSandbox 的 Node 插件，支持 `ABX_OPENSANDBOX_BASE_URL`、`ABX_OPENSANDBOX_API_KEY`；安装插件不会启动 OpenSandbox 服务。provider 插件在宿主侧执行，必须作为可信代码固定版本。[来源：provider 指南][abx-providers]。

**宿主委派与任务管理。** 文档列出 21 个 MCP 工具，含沙箱创建、连接、执行、文件上传下载、能力查询，以及 `start_task`、`get_task`、`cancel_task`、`verify_sandbox`。支持 stdio 和 HTTP；HTTP 默认监听回环地址，非回环地址要求非空认证 token。显式空 token 拒绝访问。已有这些接口，应先实测它们能否承担 R01、R06、R07，再决定是否新增接口。[来源：MCP 指南][abx-mcp]。

**后端差异。** provider 能力不一致。文档规定不支持的操作返回 `E8004`，不会自动回退到 Express；资源标识包含 provider，避免把同一 ID 误用于另一后端。这是接口层行为声明，不能代替隔离启动失败用例 F07。模板和 Agent 的接口参数也须按所选后端核对。[来源：provider 指南][abx-providers]。

**长任务的实际范围。** 代码观察：任务监督程序在沙箱内启动命令，以独立进程组运行，保存状态、PID 起始标识和 stdout/stderr；查询返回有界的输出尾部。取消逻辑向原进程组发送 SIGTERM。所查逻辑未见强制升级为 SIGKILL，不能仅凭取消返回就认定主动脱离进程组的子进程已停止。日志与状态也位于工作负载可接触的沙箱内，不能作为独立防篡改证据。[来源：tasks.ts][abx-tasks]。

**清理语义。** MCP 会话退出时清理由该会话拥有的临时沙箱；借用、保留或后台任务相关资源可能继续存活，由 TTL 或显式删除管理。观察操作不会自动续期。连接既有沙箱与创建沙箱的资源所有权不同，应记录在任务状态中。[来源：MCP 指南][abx-mcp]、[会话关闭说明][abx-shutdown]。

**适配判断。** `宿主 Codex → abx MCP → 本地 OpenSandbox → 内层 Agent` 是已有组件可以组成的候选路径，不限于云沙箱。上传下载的宿主路径边界、后台任务证据、二进制结果和删除残留仍待验证。

**优先验证。** F01–F08 对照 CLI/MCP 与选定 provider；I06、D01–D02 检查外层参数和文件路径；F06、I11–I12 检查进程组逃离、无限输出、MCP 断连、TTL 和清理失败。

## 3. OpenSandbox：运行底座与 MCP 可直接复用

**定位与前提。** 官方提供 Docker、Kubernetes 后端，以及 SDK、`osb` CLI 和 `opensandbox-mcp`。安装文档的基础前提包括 Python 3.10+、Docker Engine 20.10+ 或 Kubernetes 1.21.1+；具体安全运行时和网络组合可能有更高要求。这些是上游文档前提，尚未核对本机。[来源：安装说明][osb-install]。

**委派接口。** MCP 支持 stdio 和 Streamable HTTP，可创建、连接、查询、续期和删除沙箱，运行/中断命令及进行文本文件操作。命令可在后台执行并返回执行 ID。文档明确其未覆盖 SDK 的快照、模板、ClientPool、Credential Vault 及稳定的远程诊断日志/事件接口。不能把“SDK 支持”直接写成“宿主 Codex 通过现有 MCP 即可调用”。大文件、二进制和长任务结果查询须另核对 CLI/SDK。[来源：MCP 说明][osb-mcp]。

**内层 Codex 示例。** 固定版本示例传入接口相关环境变量，以 `codex exec --json` 获取线程 ID，再用 `codex exec resume` 继续会话，最后删除沙箱。这为 R06、R09 提供了可复用流程。示例使用 `@openai/codex@latest`，并非固定版本交付方案；实际 provider 配置、Responses 兼容性和项目导入导出仍需验证。[来源：Codex 示例代码][osb-codex]。

**控制服务和挂载。** 配置中的 `server.api_key` 控制服务鉴权。`storage.allowed_host_paths` 为空时拒绝所有宿主 bind mount，设为 `/` 则放开全部路径，应保持任务所需的窄范围。创建时的 TTL 上限并不自动约束续期后的总寿命。[来源：配置说明][osb-config]。

**网络与凭据。** egress 默认模式只过滤 DNS；需要 `dns+nft` 才增加包层执行。应显式配置 `defaultAction: deny`，并设置任务不能覆盖的平台拒绝规则，覆盖宿主、私网及实际集群网段。工作负载不持有 `NET_ADMIN`，网络 sidecar 执行策略；重定向安装失败时 sidecar 拒绝静默放行。Credential Vault 可将真实凭据留在 sidecar，通过 TLS 拦截替换占位值，需正确分发 CA，不能关闭证书验证。[来源：egress 架构][osb-egress]、[Credential Vault][osb-vault]。

**组合限制。** 文档说明当前 egress 拦截路径与 gVisor 的 nftables 能力不兼容，建议使用 Kata 或改用 CNI 层控制；透明 service mesh 也会冲突。预热池必须在池模板中准备策略，不能把每请求的 `networkPolicy` 与 pool 引用任意组合。因此“gVisor + Vault + 任意池”不能直接当成可用配置。[来源：egress 架构][osb-egress]。

**会话隔离不是必装增强项。** 另有 bubblewrap isolation session，但该功能涉及 `CAP_SYS_ADMIN` 和 AppArmor/seccomp 等运行设置。它与整个沙箱的边界不同；不要为增加内层会话功能先放宽外层权限。[来源：isolation session 指南][osb-sessions]。

**适配判断。** 可先试现有 MCP/CLI 驱动整个开发 Agent。平台策略、凭据和挂载由宿主固定，内层只收到任务配置。确认现有接口缺口后，再决定是否需要受限封装。

**优先验证。** F01–F08；I01–I12；D01–D07。尤其测试直连 IP、DNS/DoH、IPv6、sidecar 故障、Vault 流式响应、续期和控制服务重启，以及 MCP 与 SDK 的能力差异。

## 4. PAL MCP Server：复用委派逻辑需先改变执行边界

**可复用能力。** `clink` 桥接 Codex 等 CLI，可传角色、任务和文件引用，通过 `continuation_id` 继续会话。独立上下文有助于 R01、R09。PAL 自身的自定义模型 API 配置与所启动 CLI 的配置属于两条路径，不能假定 `CUSTOM_API_URL` 会自动配置内层 Codex。[来源：clink][pal-clink]、[自定义模型][pal-models]。

**关键代码观察。** 默认 Codex 客户端配置包含 `--dangerously-bypass-approvals-and-sandbox`。进程基类以指定 cwd 启动子进程，并复制 `os.environ` 后再覆盖变量；切换 cwd 不会限制宿主文件访问。超时分支调用子进程的 `kill()`，所查逻辑未体现整个沙箱或全部后代的清理。[来源：Codex 客户端配置][pal-codex]、[进程基类][pal-process]。

**适配判断。** 原样在宿主运行该桥，不能满足 R03–R05。若复用，须让实际开发 Agent 及相关文件工具在受约束运行时内执行，并限制宿主侧读文件与参数入口。仅替换一个启动命令也不自动证明所有 PAL 工具都在边界内。

**优先验证。** F02、F05–F06；I01–I07、I12。检查实际启动参数、继承环境、文件引用处理和超时后的后代进程。默认配置适合已经建立外部边界的场景与否，须按所选运行时实测。

## 5. AIO Sandbox：现成内层开发环境较完整

**执行方式。** 官方区分“Agent 调用沙箱工具”“Agent 在沙箱内”及混合模式。本项目需要整个内层 Agent 在沙箱内，外层通过工具管理它。只让宿主 Agent 调用容器 shell，不能据此推导其主进程文件工具也隔离。[来源：运行模式说明][aio-patterns]。

**模型配置。** 镜像内置 Codex CLI，支持 `CODEX_API_KEY`、`CODEX_BASE_URL`、`CODEX_MODEL` 等变量，也可注入优先级更高的 `CODEX_CONFIG_TOML` 和模型目录。文档中的自动自定义 provider 使用 Responses，不能把“自定义 URL”理解为兼容所有 Chat Completions 中转站。配置或目录语法错误会使相关启动校验退出；这只是部分失败关闭行为，尚不能代表完整 R10。[来源：Codex 集成][aio-codex]。

**委派与长任务。** `/mcp` 聚合终端、文件、浏览器等工具。shell API 提供异步执行、会话 ID、等待、查看和终止；会话内 cwd 与环境可持续，适合依赖安装及返工。管道执行路径提供 stdout/stderr、输出偏移和退出码。需要验证 MCP 实际暴露的参数是否覆盖 REST 能力，断连后能否取全日志。[来源：MCP][aio-mcp]、[shell API][aio-shell]。

**文件交付。** 文件 API 支持文本、base64、上传和流式下载，下载有文件变化处理选项。可用于导入工作区和取回二进制结果，但尚未证明已有任务基线、完整增删清单或安全补丁应用流程；REST 支持也不代表 MCP 同等支持。[来源：文件 API][aio-file]。

**安全与生命周期。** 安全说明面向可信本地开发，示例使用 `seccomp=unconfined`。可配置 `JWT_PUBLIC_KEY` 校验 bearer token，并建议回环绑定和 TLS；这些是入站防护，不能代替出站控制。生命周期 hooks 会执行容器内启动代码，应使用自己的受控配置。外层仍需管理容器创建、资源限制和销毁。[来源：安全说明][aio-security]、[生命周期 hooks][aio-lifecycle]。

**适配判断。** 可作为 Docker 路线的首批候选：已有 Agent、MCP、终端与文件能力。优先补齐受限启动配置、文件基线和交付验收，不先重写这些工具。浏览器、桌面和编辑器是否需要启用，按开发任务范围决定。

**优先验证。** F01–F08；I01–I09、I11–I12；D01–D07。先验证收紧 seccomp 后仍能完成任务，再测试接口鉴权、出站限制、取消任务及整个容器清理。

## 6. BoxLite：microVM 底座已有网络与凭据能力

**运行边界。** 官方描述每个 box 使用独立内核运行 OCI 镜像，不要求 Docker daemon；Linux 需要可访问的 `/dev/kvm`，VPS 是否支持嵌套虚拟化尚未检查。提供本地 API、CLI 和可选 REST 服务。宿主 runtime 与调用者仍是可信部分。[来源：README][box-readme]、[安全模型][box-security]。

**任务与数据。** API 支持命令执行、资源配置、文件复制与卷，以及停止/启动、克隆、导出和导入。停止后可保留实例，适合返工；克隆或导出的是环境状态，不能代替相对项目基线的代码差异。需明确 `auto_remove`、持久数据和任务归属。[来源：生命周期示例][box-lifecycle]、[克隆与导出示例][box-clone]。

**网络默认值。** `network` 默认启用，空 `allow_net` 表示不限出站。配置允许清单可限制 IP/CIDR，或按域名匹配 TLS SNI/HTTP Host；只有域名规则时拒绝普通 UDP。但文档明确 DNS 查询仍交给宿主解析器，不受该清单限制，存在通过查询名泄露数据的通道。`host.boxlite.internal` 还可在未限制时访问宿主回环服务。不能将这套清单直接表述为完整数据外传防线。[来源：配置参考][box-config]。

**凭据与动态策略。** `secrets` 可把真实凭据留在宿主，用占位环境变量和 HTTPS 请求替换提供给 guest；对应目标会隐式获得 443 出站许可，必须与 `allow_net` 一起审核。直接传入的真实环境变量仍会出现在 box 元数据中。运行时更新允许清单是完整替换，空清单重新放开，已有连接继续沿用旧策略。[来源：配置参考][box-config]、[网络更新说明][box-network]。

**加固范围。** 安全文档提供 jailer、namespace、seccomp、cgroups、降权等选项，同时说明默认偏向兼容性。应记录实际启用的配置，不能假定所有加固均已开启。guest 的能力集与宿主 jailer 是不同层。[来源：安全模型][box-security]。

**适配判断。** 有 KVM 时可评估更强执行边界；不必绑定 Octo。应先用现有 CLI/API 跑通任务，再核对所需策略是否能通过 BoxLite MCP 传入。

**优先验证。** F01–F08；I06–I08、I10–I12；D01–D07。特别检查 KVM 缺失时停止、DNS 外传、宿主回环、凭据隐式网络许可、持久实例残留和宿主复制路径。

## 7. BoxLite MCP：可调用，但须核对路径和清理结果

**现有工具。** README 和 `server.py` 提供 computer、browser、code interpreter 及通用 sandbox 工具。通用工具支持启动、停止、exec、copy in/out，exec 返回退出码和 stdout/stderr。适合复用 R01、R06 的基本入口；所查工具未体现开发任务的持久提交、轮询、返工状态协议。[来源：README][boxmcp-readme]、[server.py][boxmcp-code]。

**宿主参数。** 代码观察：启动参数可传 image、volumes、env、资源、ports、network 等；复制接受 `host_path`、`host_dest`，所查 handler 直接交给运行时，未见项目根允许清单。网络参数主要是布尔开关，未见同一 schema 暴露新版运行时的 `allow_net` 与 `secrets`。因此需要区分底层能力和 MCP 接口能力。[来源：server.py][boxmcp-code]。

**清理返回值。** 代码观察：通用 sandbox stop 捕获清理异常并记录日志，随后移除内部句柄，仍返回成功；工具层可报告已停止。该观察限于所查路径，不表示所有 stop 都失败，但意味着不能只相信成功文本，应从 runtime 核对实例和进程状态。[来源：server.py][boxmcp-code]。

**版本组合。** 所查包版本为 `0.2.5`，依赖为 `boxlite>=0.5.10`，没有上限。这不能证明它与所查 BoxLite 新提交兼容。部署前固定桥接包、runtime 和镜像组合，验证参数及清理语义。[来源：pyproject.toml][boxmcp-deps]。

**适配判断。** 优先在宿主以固定任务目录和受限账号调用；不让不可信任务决定任意宿主挂载、端口和导出路径。已有 CLI/API 若能满足流程，可以先使用它们，避免为统一 MCP 外观立刻开发新服务。

**优先验证。** I06–I07、I12；D01–D02；F06–F07。注入停止失败、复制越界和依赖不兼容，核对真实状态及错误传播。

## 8. Hullwork Sandbox：会话、文件制品和权限分工值得复用

**运行与管理分工。** 参考生产方案使用 Kubernetes + gVisor、非 root、只读根文件系统、受限 capabilities、不挂载 ServiceAccount token。Agent 的 stdio MCP 用控制服务 URL、token 和 session ID 连接；文档列出 9 个 shell、会话、状态、文件及检查点工具，不把租户、key、模板、审计和任意运行时管理放入同一工具面。[来源：安全模型][hull-security]、[使用说明][hull-usage]。

**长任务与依赖。** 普通 shell 单次上限为 30 秒，PTY 会话支持异步执行、等待和交互，会话最长存活 1 小时。默认镜像移除了 pip；任意依赖安装不能假定可直接执行，按官方方式构建自定义受控镜像，工作区级依赖安装另行验证。单 VPS 要评估 Kubernetes、存储及控制服务的部署成本。[来源：使用说明][hull-usage]、[配置说明][hull-config]。

**导入导出。** 文本工具有大小限制，大文件和二进制通过对象存储的一次性票据处理。文件/集合导出可提供路径、大小与 SHA256 清单，只导出普通文件并跳过符号链接。安全文档描述了归档路径、链接、设备条目、大小和数量检查。这些机制与 R08、D01–D02 直接相关，但清单哈希不证明代码或测试正确。[来源：使用说明][hull-usage]、[安全模型][hull-security]。

**网络的实际放行范围。** 参考策略先默认拒绝 ingress/egress，再放行 DNS 与公共 TCP 80/443，并排除列出的私网、回环和链路本地网段。它不是仅允许指定中转站和依赖站点的域名策略；实际集群及服务 CIDR 也须加入拒绝范围。效果依赖 CNI 执行 NetworkPolicy。开发覆盖配置和共享存储的边界更弱。[来源：安全模型][hull-security]。

**返工与删除。** session 绑定工作区，复用 session 可继续改文件；应按任务分配身份，避免不同任务误共享。检查点保存文件，不恢复进程内存；恢复会替换工作区。runtime 停止不等于删除 PVC、对象存储或数据库记录，应分别定义保留和销毁策略。[来源：使用说明][hull-usage]、[生命周期与数据][hull-lifecycle]。

**适配判断。** 已有 Kubernetes/gVisor 条件时值得试配；个人 VPS 是否承担该运维成本仍未决定。可重点借鉴它把 Agent 工具与管理面分开、用清单交付制品的实现思路。

**优先验证。** F03–F07；I05–I12；D01–D07。检查会话交叉访问、CNI 实际阻断、归档异常、检查点恢复及工作区/对象/凭据残留。

## 9. Hullwork Site：关注发布结果的可验证性

**能力范围。** README 描述 Kubernetes 上的网站部署 API、CLI、MCP，支持从源码构建或使用已有 OCI 镜像，并记录 HTTP 实际响应状态及 SHA256 验证结果。架构采用不可变版本、内容寻址制品和切换当前版本指针。它解决的是构建发布与访问结果核对，不是整个开发 Agent 的执行隔离。[来源：README][site-readme]、[架构][site-arch]。

**与本需求的关系。** 以后若要把“构建成功”与“实际站点内容符合预期”分开验收，可参考其结果验证方式。HTTP 内容哈希不能代替代码审查或测试。其 Kubernetes 发布控制面及依赖服务不应成为本需求的必装前提。

**接口代码观察。** MCP 使用调用者身份和租户授权，不应把内层开发 Agent 直接赋予发布管理员身份；开发交付和网站发布仍应是两个受控动作。[来源：API/MCP 实现][site-mcp]。

**适配判断。** 暂列配套参考。核心选型不因它支持 MCP 就增加一个部署平台；如将来纳入发布范围，再验证权限、构建副作用、回滚和验证失败处理。

## 10. Octo Agent：可作为内层执行器，需明确非交互返工方式

**模型协议。** 配置源码允许 `anthropic`、`openai`、`openai-responses` 三类 provider，支持自定义接口。不同资料中的配置表未完全同步，应以所选版本源码和协议说明核对，实际中转站仍需测试流式、工具调用和错误处理。[来源：配置源码][octo-config]。

**非交互执行。** 支持直接传任务、`--prompt-file` 或标准输入；`--stream=false` 可只返回最终文本。headless 文档明确它会运行完整 Agent/工具循环，但**不持久化会话**。TUI 的 JSONL 会话和 `-c` 恢复不能直接算作 headless 的 R09 已满足。可评估持久工作区加显式返工上下文，或另行核验服务端会话接口。[来源：headless 设计][octo-headless]、[CLI 实现][octo-chat]、[会话说明][octo-sessions]。

**无人值守行为。** 非 TTY 下无法交互确认的 Ask 默认拒绝，需要预设权限；`max-turns` 默认不限。外层应设置任务时间、资源和输出限制，不能把工具权限弹窗当作无人值守边界。[来源：headless 设计][octo-headless]、[CLI 实现][octo-chat]。

**内置沙箱范围。** 设计明确 OS 沙箱默认关闭，覆盖前台和后台终端命令。Linux 使用 Landlock 等限制；请求启用而不可用时返回错误。代码观察：主进程文件工具调用 `os.Open`，Linux shell 子进程复制 `os.Environ()`。因此单独启用 `--sandbox` 不能证明主进程文件工具、外部 MCP、HOME 和凭据均隔离；安全说明也把它定位为单用户可信环境的工具。[来源：沙箱设计][octo-sandbox]、[文件工具][octo-file]、[环境继承][octo-env]、[安全说明][octo-security]。

**适配判断。** 放入 Docker、BoxLite、OpenShell 等完整运行边界后，再作为开发 Agent 候选。使用自己的 HOME、配置、MCP 和 hooks，限制权限档案。它不是必选项，是否采用取决于模型兼容性与返工体验。

**优先验证。** F02–F07；I01–I05、I11–I12；D05–D06。检查 headless 失败退出码、轮数和时间限制、权限拒绝、全部工具的实际路径及返工上下文。

## 11. NVIDIA OpenShell：文件、网络和凭据策略与保护目标直接相关

**运行与宿主前提。** 支持 Docker、Podman、Kubernetes、microVM 等后端。固定文档列 Docker 28.0+、Podman 5.x、Kubernetes 1.29+；microVM 另需虚拟化。隔离边界要求 Landlock ABI 3（Linux 6.2 起）、seccomp 用户通知及 ADDFD 原子发送、同 UID 子任务内存读取等能力，会在准入时探测；版本号符合不等于探测通过。默认 Ubuntu 24.04 工作负载镜像不含 Agent CLI，需选受控镜像。[来源：支持矩阵][shell-support]。

**默认策略与执行模式。** 文件系统和进程策略在创建时固定，网络和 provider 可动态更新。默认无网络规则时拒绝出站，但未传 `--policy` 不保证使用最严格默认值：全局、已保存、镜像策略和已附加 provider 都影响有效策略。要同时核对 `openshell policy get --base` 与 `--full`。请求级 L7 规则默认 `audit`，会记录并转发，必须切到 `enforce` 才拒绝不合规请求；这不表示所有网络端点规则默认都仅审计。[来源：默认策略][shell-default]、[安全最佳实践][shell-security]。

**凭据可不交给开发进程。** provider profile 将凭据绑定到目标 host、port、规范化 path 和可用二进制；开发进程使用占位值，由代理替换真实凭据。内置 OpenAI profile 明确面向 `api.openai.com`；把 `base_url` 改成中转站不会自动授权它获取同一密钥，应建立专用中转站 profile。附加 provider 也可能扩展网络许可，需检查完整策略。直接传入真实环境变量不具有相同保护。[来源：provider profile][shell-profiles]、[内置 OpenAI profile][shell-openai]。

**委派、文件和返工。** CLI 支持分离启动、非交互 exec 和连接既有沙箱；exec 传播命令退出码及流交付错误，不会自动重放执行。connect 的输出重放不等于内层 Agent 会话恢复。文件同步示例支持 upload/download，采用有界帧的原生流式归档协议；宿主目标目录、链接处理和项目差异仍需验收。默认 exec 的登录 shell 会加载工作负载启动文件，`--no-login-shell` 也不能单独消除 `BASH_ENV` 等环境入口。[来源：沙箱操作][shell-sandbox]、[文件同步][shell-files]。

**示例的适用边界。** Codex app-server 示例使用宿主 `.codex/auth.json` 登录，不能照搬为内层中转站配置。本项目仍要求宿主官方 Codex 保持原有交互，内层只取得专用中转站身份。[来源：app-server 示例][shell-codex]。

**适配判断。** CLI 已能作为第一阶段委派入口，无需先认定必须另写 MCP。应重点验证宿主能力、专用中转站 profile、完整策略和文件交付。文件/进程策略需要重建时，返工流程应保留明确的任务基线。

**优先验证。** F01–F08；I01–I12；D01–D07。特别测试内核探测失败、审计与执行模式差异、精确域名授权是否放行内网、不同 path/二进制的凭据替换、启动文件和归档导出边界。

## 用调研结果安排验证

以上是资料与部分代码核查，尚不能给出实测排名。建议按[需求对照与试配路线](capability-matrix.md)验证已有组合，按[验证计划](../devdocs/validation.md)留证。确认需要补充哪些配置、脚本或接口后，再作技术决策；不把所有项目串成一个必装系统。

[magpie-readme]: https://github.com/yetone/magpie/blob/987e019d442697e3648c2bd4802e283d30dd8461/README.md
[magpie-codex]: https://github.com/yetone/magpie/blob/987e019d442697e3648c2bd4802e283d30dd8461/internal/agent/codex.go
[abx-providers]: https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/providers.md
[abx-mcp]: https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/mcp-integration.md
[abx-shutdown]: https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/mcp-session-shutdown.md
[abx-tasks]: https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/src/agent/tasks.ts
[osb-install]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/getting-started/installation.md
[osb-config]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/getting-started/configuration.md
[osb-mcp]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/sdks/mcp.md
[osb-codex]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/examples/codex-cli/main.py
[osb-egress]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/architecture/network/egress.md
[osb-vault]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/guides/credential-vault.md
[osb-sessions]: https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/guides/isolation-sessions.md
[pal-clink]: https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/tools/clink.md
[pal-codex]: https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/conf/cli_clients/codex.json
[pal-process]: https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/clink/agents/base.py
[pal-models]: https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/custom_models.md
[aio-patterns]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/start/agent-sandbox.md
[aio-codex]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/advanced/codex.md
[aio-mcp]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/mcp.md
[aio-shell]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/shell.md
[aio-file]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/file.mdx
[aio-security]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/advanced/security.md
[aio-lifecycle]: https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/advanced/lifecycle.md
[box-readme]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/README.md
[box-security]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/concepts/security.md
[box-config]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/reference/configuration.md
[box-network]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/guides/networking.md
[box-lifecycle]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/examples/python/03_lifecycle/manage_lifecycle.py
[box-clone]: https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/examples/python/03_lifecycle/clone_export_import.py
[boxmcp-readme]: https://github.com/boxlite-ai/boxlite-mcp/blob/9256a296e14bb7e4700454bec3fabba11670e203/README.md
[boxmcp-code]: https://github.com/boxlite-ai/boxlite-mcp/blob/9256a296e14bb7e4700454bec3fabba11670e203/server.py
[boxmcp-deps]: https://github.com/boxlite-ai/boxlite-mcp/blob/9256a296e14bb7e4700454bec3fabba11670e203/pyproject.toml
[hull-security]: https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/SECURITY_MODEL.md
[hull-usage]: https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/USAGE.md
[hull-lifecycle]: https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/LIFECYCLE_AND_DATA.md
[hull-config]: https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/CONFIGURATION.md
[site-readme]: https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/README.md
[site-arch]: https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/docs/ARCHITECTURE.md
[site-mcp]: https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/src/sites/api_mcp.py
[octo-headless]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/dev-docs/headless-oneshot.md
[octo-chat]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/cmd/octo/chat.go
[octo-config]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/config/config.go
[octo-security]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/docs/src/content/docs/zh/reference/security.md
[octo-sandbox]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/dev-docs/c11-sandbox-design.md
[octo-file]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/tools/read_file.go
[octo-env]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/sandbox/sandbox_linux.go
[octo-sessions]: https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/docs/src/content/docs/zh/concepts/sessions-and-history.md
[shell-support]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/about/support-matrix.mdx
[shell-default]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/policies/default-policy.mdx
[shell-security]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/security/best-practices.mdx
[shell-profiles]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/providers/profiles.mdx
[shell-openai]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/providers/openai.yaml
[shell-sandbox]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/sandboxes/overview.mdx
[shell-files]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/examples/sync-files.md
[shell-codex]: https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/examples/codex-app-server/README.md
