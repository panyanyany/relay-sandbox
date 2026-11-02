# 资料索引与证据

整理日期：2026-11-02。复查[项目调研](projects.md)时，使用下列官方资料和固定提交核对结论。本文仅保存链接、摘要和少量代码观察，不复制整篇文章或第三方仓库。动态页面可能变化，重要代码观察使用固定提交链接。抓取到的提交日期不代表发布版本或运行时兼容性。

## 用户提供的三个 V2EX 原帖

| 原帖 | 对应项目 | 使用方式 |
| --- | --- | --- |
| [1180142：BoxLite](https://www.v2ex.com/t/1180142) | BoxLite、BoxLite MCP | 发现项目与 MCP 链接；技术细节以当前官方资料为准 |
| [1239711：gVisor 沙箱与网站部署](https://www.v2ex.com/t/1239711) | Hullwork Sandbox、Hullwork Site | 了解作者说明、边界和发布时状态 |
| [1228101：开源 Agent](https://www.v2ex.com/t/1228101) | Octo Agent | 了解定位；沙箱边界另查文档与实现 |

候选范围以[项目调研](projects.md)为准。帖子中的其他链接或评论未自动纳入候选清单。

## 官方资料

| 编号 | 资料 | 支持的观察或后续用途 |
| --- | --- | --- |
| S01 | [Magpie README](https://github.com/yetone/magpie) | 模型路由与配置；执行隔离需另证 |
| S02 | [abx README](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox) | 沙箱 CLI、默认云后端、模板和 MCP 入口 |
| S03 | [abx MCP](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/main/docs/en/guide/mcp-integration.md) | MCP 的传输和操作能力 |
| S04 | [abx CLI 参考](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/main/docs/en/reference/cli-reference.md) | 配置与命令参数，具体 Agent 模板另查 |
| S05 | [OpenSandbox README](https://github.com/opensandbox-group/OpenSandbox) | Docker / Kubernetes、SDK、CLI、MCP 与 Agent 示例 |
| S06 | [PAL MCP Server](https://github.com/BeehiveInnovations/pal-mcp-server) | 多模型和 CLI 桥接，不能据此推断执行隔离 |
| S07 | [AIO Sandbox](https://github.com/agent-infra/sandbox) | 一体化开发环境项目入口 |
| S08 | [AIO Codex 集成](https://sandbox.agent-infra.com/zh/guide/advanced/codex) | 内置 CLI、自定义模型与接口配置 |
| S09 | [AIO MCP 集成](https://sandbox.agent-infra.com/zh/guide/basic/mcp) | 终端、文件及其他工具 |
| S10 | [AIO 安全](https://sandbox.agent-infra.com/zh/guide/advanced/security) | 默认信任前提、示例运行参数、鉴权与凭据处理 |
| S11 | [BoxLite README](https://github.com/boxlite-ai/boxlite) | microVM、运行要求和 SDK |
| S12 | [BoxLite MCP README](https://github.com/boxlite-ai/boxlite-mcp) | 现成 MCP 工具 |
| S13 | [Hullwork Sandbox README](https://github.com/hullwork/sandbox) | 运行时、部署与权限设计 |
| S14 | [Hullwork 使用说明](https://github.com/hullwork/sandbox/blob/main/docs/USAGE.md) | 会话绑定的 MCP 工具与管理操作边界 |
| S15 | [Hullwork Site](https://github.com/hullwork/site) | 网站构建、版本切换、HTTP 状态与内容哈希验证 |
| S16 | [Octo README](https://github.com/open-octo/octo-agent) | 模型接口、非交互运行、工具 |
| S17 | [Octo 沙箱指南](https://octo-agent.dev/docs/zh/guides/sandbox-the-agent/) | opt-in 沙箱及平台机制 |
| S18 | [Octo MCP 指南](https://octo-agent.dev/docs/zh/guides/connect-mcp-servers/) | 消费外部 MCP 服务，不能据此认定自身提供委派服务 |
| S19 | [OpenShell README](https://github.com/NVIDIA/OpenShell) | 运行时、CLI、SDK、skills 与策略入口 |
| S20 | [OpenShell 官方概述](https://docs.nvidia.com/openshell/about/overview) | 文件、网络、进程和 provider 凭据控制 |
| S21 | [Docker 安全](https://docs.docker.com/engine/security/) | 共享内核、daemon 控制权与容器权限边界 |
| S22 | [Rootless Docker](https://docs.docker.com/engine/security/rootless/) | 非 root daemon 和容器运行方式 |
| S23 | [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) | 宿主文件挂载及可写挂载的影响 |

## 2026-11-02 固定提交核查

通过 GitHub API 查询仓库元数据与文件树，再读取固定提交的 README、相关文档和部分源文件。下表是核查快照，**不是已安装版本、release 清单或完整安全审计**。没有运行下载的程序，也没有执行隔离验收。提交时间按 UTC 记录。

| 仓库 | 固定提交 | 提交日期（UTC） | 阅读范围 |
| --- | --- | --- | --- |
| yetone/magpie | [`987e019d442697e3648c2bd4802e283d30dd8461`](https://github.com/yetone/magpie/tree/987e019d442697e3648c2bd4802e283d30dd8461) | 2026-11-02 | README、Codex 配置适配器、provider/account 与 MCP 路由资料 |
| Alibaba-Agent-Sandbox/agent-sandbox | [`b77b75d91617483bc088f28b8eaecf74cbea711a`](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/tree/b77b75d91617483bc088f28b8eaecf74cbea711a) | 2026-10-29 | provider、MCP、会话关闭文档；后台任务和 MCP 入口源码 |
| opensandbox-group/OpenSandbox | [`65459dcf667094a22db0ac4ab86f797223c713ad`](https://github.com/opensandbox-group/OpenSandbox/tree/65459dcf667094a22db0ac4ab86f797223c713ad) | 2026-11-02 | 安装/配置、MCP、Codex 示例、egress/Vault、会话隔离与安全运行时资料 |
| BeehiveInnovations/pal-mcp-server | [`7afc7c1cc96e23992c8f105f960132c657883bb1`](https://github.com/BeehiveInnovations/pal-mcp-server/tree/7afc7c1cc96e23992c8f105f960132c657883bb1) | 2025-12-15 | clink、自定义模型；Codex 默认参数和子进程基类 |
| agent-infra/sandbox | [`7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c`](https://github.com/agent-infra/sandbox/tree/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c) | 2026-09-14 | 运行模式、Codex、MCP、文件/shell、安全与生命周期文档 |
| boxlite-ai/boxlite | [`578a6425548677d5f8aa68a45775347cd8a2ca2d`](https://github.com/boxlite-ai/boxlite/tree/578a6425548677d5f8aa68a45775347cd8a2ca2d) | 2026-11-02 | 安全/网络/配置文档；生命周期、复制、克隆导出示例 |
| boxlite-ai/boxlite-mcp | [`9256a296e14bb7e4700454bec3fabba11670e203`](https://github.com/boxlite-ai/boxlite-mcp/tree/9256a296e14bb7e4700454bec3fabba11670e203) | 2026-02-09 | server.py 工具 schema、挂载/复制/stop handler；包依赖 |
| hullwork/sandbox | [`beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8`](https://github.com/hullwork/sandbox/tree/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8) | 2026-09-10 | 安全、使用、生命周期、配置资料；会话 MCP 和参考网络策略 |
| hullwork/site | [`3adec9a5ffd66594a701bbe1d6a4af3617a86c78`](https://github.com/hullwork/site/tree/3adec9a5ffd66594a701bbe1d6a4af3617a86c78) | 2026-09-10 | README、架构/配置资料；API/MCP 调用者身份入口 |
| open-octo/octo-agent | [`2f808d0ae5da206394e566aff2eb252782d334c7`](https://github.com/open-octo/octo-agent/tree/2f808d0ae5da206394e566aff2eb252782d334c7) | 2026-10-29 | headless/沙箱/会话/安全资料；配置、CLI、文件工具和 Linux 沙箱源码 |
| NVIDIA/OpenShell | [`42671c2dd2c02b744850e0bda72b99d5509969c1`](https://github.com/NVIDIA/OpenShell/tree/42671c2dd2c02b744850e0bda72b99d5509969c1) | 2026-10-31 | 支持矩阵、默认/网络策略、provider、安全、沙箱操作、同步和 Codex 示例 |

## 按问题追溯固定版本证据

逐项目记录中的来源链接也全部固定到上表提交。以下列出会影响需求适配或验收方式的主要文件，便于定向复查。外部文档中的安全声明仍是上游声明；代码观察只涉及所列入口。

| 问题 | 固定来源 | 证据范围 |
| --- | --- | --- |
| Magpie 会读取或改动哪些 Agent 配置？ | [README](https://github.com/yetone/magpie/blob/987e019d442697e3648c2bd4802e283d30dd8461/README.md)、[Codex 适配器](https://github.com/yetone/magpie/blob/987e019d442697e3648c2bd4802e283d30dd8461/internal/agent/codex.go) | 文档及配置写入路径观察；不代表所有凭据发现入口均已审计 |
| abx 能否连接本地后端？ | [provider 指南](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/providers.md)、[MCP 集成](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/mcp-integration.md) | 文档明确本地 OpenSandbox 插件与接口范围；未安装插件 |
| abx 取消是否覆盖所有进程？ | [任务实现](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/src/agent/tasks.ts)、[会话关闭](https://github.com/Alibaba-Agent-Sandbox/agent-sandbox/blob/b77b75d91617483bc088f28b8eaecf74cbea711a/docs/en/guide/mcp-session-shutdown.md) | 进程组、输出尾部和所有权清理观察；脱离进程组行为待实测 |
| OpenSandbox MCP 是否覆盖全部 SDK？ | [MCP 范围](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/sdks/mcp.md)、[Codex 示例](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/examples/codex-cli/main.py) | 接口文档与非交互/resume 示例；不代表完整开发交付 |
| OpenSandbox 如何限制出站和凭据？ | [egress 架构](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/architecture/network/egress.md)、[Vault](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/guides/credential-vault.md)、[配置](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/getting-started/configuration.md) | DNS/nft、运行时组合、CA、挂载和 TTL 文档；未审计整个数据面 |
| OpenSandbox 会话隔离是否影响外层权限？ | [isolation session](https://github.com/opensandbox-group/OpenSandbox/blob/65459dcf667094a22db0ac4ab86f797223c713ad/docs/guides/isolation-sessions.md) | 功能前提和权限文档；不建议未经验证直接启用 |
| PAL 的默认 Codex 权限和环境是什么？ | [Codex 参数](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/conf/cli_clients/codex.json)、[进程基类](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/clink/agents/base.py)、[clink](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/tools/clink.md) | 固定参数、环境复制与超时分支观察；不是整仓审计 |
| AIO 支持什么模型配置和执行模式？ | [运行模式](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/start/agent-sandbox.md)、[Codex 配置](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/advanced/codex.md)、[shell](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/shell.md) | 文档说明 Responses、异步执行及会话；尚未验证中转站 |
| AIO 能否交付文件并安全暴露接口？ | [文件 API](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/file.mdx)、[MCP](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/basic/mcp.md)、[安全](https://github.com/agent-infra/sandbox/blob/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c/website/docs/zh/guide/advanced/security.md) | REST/MCP 资料与信任前提；入站鉴权不代表出站限制 |
| BoxLite 网络默认值和 secrets 的关系？ | [配置参考](https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/reference/configuration.md)、[网络更新](https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/guides/networking.md)、[安全](https://github.com/boxlite-ai/boxlite/blob/578a6425548677d5f8aa68a45775347cd8a2ca2d/docs/concepts/security.md) | 默认出站、DNS 例外、隐式授权和加固文档；未验证运行时 |
| BoxLite MCP 是否约束宿主路径并可靠报告 stop？ | [工具实现](https://github.com/boxlite-ai/boxlite-mcp/blob/9256a296e14bb7e4700454bec3fabba11670e203/server.py)、[包依赖](https://github.com/boxlite-ai/boxlite-mcp/blob/9256a296e14bb7e4700454bec3fabba11670e203/pyproject.toml) | 所查 schema、handler、异常处理及依赖版本；非完整安全审计 |
| Hullwork 的网络、制品和工作区生命周期？ | [安全模型](https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/SECURITY_MODEL.md)、[使用说明](https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/USAGE.md)、[数据生命周期](https://github.com/hullwork/sandbox/blob/beb163f67f9b5bb8eecb5ed09dac83c8b20d70c8/docs/LIFECYCLE_AND_DATA.md) | 参考策略、MCP、票据/清单、检查点和持久存储文档 |
| Hullwork Site 验证什么？ | [README](https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/README.md)、[架构](https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/docs/ARCHITECTURE.md)、[API/MCP](https://github.com/hullwork/site/blob/3adec9a5ffd66594a701bbe1d6a4af3617a86c78/src/sites/api_mcp.py) | 网站状态/哈希、版本和身份入口；非开发 Agent 隔离结论 |
| Octo headless 是否持久化，支持哪些协议？ | [headless](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/dev-docs/headless-oneshot.md)、[CLI](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/cmd/octo/chat.go)、[provider 配置](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/config/config.go) | 文档和配置/命令源码观察；中转站兼容性仍待实测 |
| Octo 沙箱覆盖哪些工具和环境？ | [沙箱设计](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/dev-docs/c11-sandbox-design.md)、[文件工具](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/tools/read_file.go)、[Linux 环境](https://github.com/open-octo/octo-agent/blob/2f808d0ae5da206394e566aff2eb252782d334c7/internal/sandbox/sandbox_linux.go) | 终端子进程与主进程文件入口的区别；不能推断所有调用均可越权 |
| OpenShell 在什么主机上运行？ | [支持矩阵](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/about/support-matrix.mdx)、[默认策略](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/policies/default-policy.mdx) | 运行时、内核准入及有效策略文档；尚未执行本机探测 |
| OpenShell 如何约束请求和中转站密钥？ | [安全实践](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/security/best-practices.mdx)、[profile](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/providers/profiles.mdx)、[OpenAI profile](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/providers/openai.yaml) | 审计/执行模式、endpoint 与凭据绑定说明；不复用官方身份 |
| OpenShell 如何执行、取文件和接 Codex？ | [沙箱操作](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/docs/how-it-works/sandboxes/overview.mdx)、[文件同步](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/examples/sync-files.md)、[app-server 示例](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/examples/codex-app-server/README.md) | CLI、传输和示例边界；示例官方登录不能直接用作中转站任务身份 |

## 从资料结论转为实测结论

1. 先固定实际 release、包版本和镜像 digest。main 快照不能代替可复现安装清单。
2. 使用专用测试目录和假凭据执行[验证计划](../devdocs/validation.md)。记录有效策略，不只记录命令行参数。
3. 分别记录 CLI、MCP、SDK 暴露的能力。底层存在功能不代表当前桥接层已提供。
4. 把证据保存在适当目录。公开记录不含真实密钥、本机服务标识或私有日志。
5. 按实测结果更新[需求对照表](capability-matrix.md)与[决策记录](../devdocs/decisions.md)，保留未覆盖范围。

## 阅读与复查原则

- 区分第三方介绍、官方能力说明、代码观察与实机证据。
- 不用 star 数、宣传用语或“完全隔离”等表述替代验证。
- 原帖时间、抓取时间、main 提交时间和 release 版本可能不同，不互相替代。
- 运行前选择实际版本，记录镜像 digest、Agent 版本和策略；当前资料不是可复现部署配置。
- 不把“没有确认功能”写成“确定不支持”，也不把“有接口可以组合”写成“已开箱即用”。
