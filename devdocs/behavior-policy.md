# 配置行为策略和通信观察

先由用户在宿主状态目录配置授权，再创建新任务。项目文件和模型工具调用不能授予宿主权限。当前实现采用 Docker；组件与入口的实际验收分别见[实现验证记录](implementation-validation.md)和[行为策略验收](../.rope/issues/behavior-policy/e2e.md)。

## 配置宿主授权

在 `--home` 指定的状态目录创建 `permissions/<projectId>.yaml`。没有文件时使用默认值；非法字段或资源申请明确失败。不要把此文件放入项目副本。

```yaml
version: 1
network:
  grants: []
resources:
  - name: reference-data
    source: /srv/example-data
    target: /mnt/reference-data
    mode: copy
    access: read-only
decoys:
  enabled: false
  clients: []
```

示例路径是占位符，必须替换为用户明确允许的普通目录。`mode` 默认 `copy`，`access` 默认 `read-only`。副本与宿主源独立，候选检查和恢复复用任务副本。`direct` 模式直接挂载；`read-write` 可能立即改变宿主源，绕过最终项目交付检查。清理仅删除任务副本，不删除源。

项目 `relay-sandbox.yaml` 可用 `resourceRequests: [reference-data]` 申请已授权名称。未申请名称时使用该项目宿主配置中已明确授权的全部资源。未知名称失败。源不能指向受保护的状态/原项目区域，目标不能覆盖工作区、系统保留路径或工具根；链接、重叠及无法保证的挂载边界拒绝。

网络默认允许公网、外部内网和同任务服务，默认拒绝宿主及其他任务。确需例外时，在宿主配置增加明确 IPv4/CIDR、端口和协议：

```yaml
network:
  grants:
    - target: 192.0.2.10
      ports: [8443]
      protocol: tcp
```

示例地址不可直接作为可达测试目标。授权优先于默认拒绝，用户应确认范围。支持 `ports: all`；`protocol: any` 只能搭配全部端口。不提供 IPv6，当前任务地址池为 `198.19.0.0/16`，与实际路由或无关 Docker 网络冲突时明确失败。

任务创建时冻结配置，并与项目配置共同生成审核摘要。修改文件只影响新任务。恢复不读取新授权；没有策略快照的旧任务保持旧的限制性网络规则。

## 配置主项目访问方式

宿主授权文件支持 `project: { mode: direct }`（新任务默认）或 `project: { mode: isolated }`。直接模式只挂载已登记的原项目，不从项目文件接受源路径或授权；有排除规则时拒绝创建。主项目和额外目录授权分开，模式与其他授权共同冻结。直接修改立即生效，后续检查不回滚，详见[项目访问方式](project-access.md)。

## 显式启用诱饵

把 `decoys.enabled` 改为 `true`，并明确列出需要观察的已验证客户端。`clients: []` 表示没有配置受控客户端，不会自动启用所有工具。

```yaml
decoys:
  enabled: true
  clients:
    - id: curl-7-88-1
      tool: curl
      version: 7.88.1
      trustStore: explicit-ca-file
      invocation: [curl, --disable]
```

通过 `get_capabilities.trafficAudit.verifiedClients` 查看完整组合：

| 工具 | 已验证版本/库 | 信任与调用 |
| --- | --- | --- |
| curl | 7.88.1 | 显式 CA 文件；`curl --disable` |
| wget | GNU Wget 1.21.3 | 显式 CA 文件；`wget --no-config` |
| Python | 3.11.2 / urllib.request@3.11.2 | 独立 urllib 请求入口和局部 SSLContext |

只有符合组合及支持参数的显式 helper 调用可解密。开发 Agent 的当轮提示会提供当前主环境工具路径。目录格式为 `/opt/relay-sandbox/audit/<runtimeId>/`，包含公共 CA、`clients.json`、`traffic-client.py`、`traffic-python.py` 和共享的 `traffic_context.py`。curl/wget 通过前者传入 catalog 和原工具参数，Python 通过后者传入 catalog、方法、正文和 URL。这不是对任意 Python 程序的拦截。

不替换系统工具、PATH、全局代理或常用凭据变量。未知版本/参数/信任配置在首个请求前免解密；代理预检不可用也直通，已开始的请求不自动重放。所有路径保留真实站点证书校验；坏证书仍失败。显式启动全新业务请求由调用方决定。

诱饵是明显无效的 AWS/OpenRouter 假值，独立文件位于沙箱 `/home/node/.config/relay-sandbox/decoys/`。不使用默认 SDK 凭据路径，不覆盖或合并已有文件；冲突跳过。恢复原任务沿用原假值，重新生成代理运行目录及证书。开发容器拿不到代理私钥。

## 审查结果与覆盖缺口

`get_result.policy` 和 `report_task` 报告冻结授权、资源模式、最小命中及覆盖缺口。运行 `supervise` 才会定期刷新代理存活状态；MCP 本身没有事件钩子、推送或自动唤醒。宿主可通过能力声明选择有界等待或轮询。

命中包含时间、目标主机/端口、诱饵编号、编码和位置；受控入口还可附带调用编号、请求编号及客户端声明的容器内进程信息。详见[调用关联](traffic-correlation.md)。支持原值、percent、标准及 URL-safe Base64；AWS 派生签名、任意变换和免解密流量不保证匹配。命中不等于恶意或远端已收到；未命中不等于没有泄漏。大请求、未知压缩、缺失/损坏/轮转/截断证据均是覆盖缺口。

普通内部安装和配置修改按容器用户权限允许，不自动提权。运行期风险和观察失败只用于提醒，不单独否决正确代码。强制隔离建立失败不派发；检测到失效须停止，停止失败如实记录。候选代码本身的恶意行为仍由启用的宿主审核拒绝。

## 清理私密材料

正常停止移除辅助代理并回收其私密清单副本和 CA 私钥，保留任务主清单供恢复以及最小证据。完整 cleanup 再删除主诱饵、资源副本和运行资源。报告保留期到期后由 gc 删除流量证据，保留最小摘要、任务元数据及备份。失败保留可重试状态，不声称清理成功。周期指标与日志保留设置见[指标与清理](observability.md)。

## 授权容量与有界报告

新冻结授权快照上限为 64 KiB。通信报告单次最多读取 4 MiB、解析 20000 条记录，优先当前主环境；截断计数只代表已扫描命中。具体契约和错误示范见[维护性修复](maintenance.md)。
