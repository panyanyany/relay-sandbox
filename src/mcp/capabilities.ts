import { TASK_EVENT_SUBSCRIPTION_LIMIT } from "./task-subscriptions.js";
import { VERIFIED_CLIENTS } from "../traffic/clients.js";

// 能力声明只列已实现机制，宿主据此选择等待方式，不推测客户端唤醒能力。
export function mcpCapabilities() {
  return {
    schemaVersion: 1,
    configuration: {
      initialize: "initialize_relay",
      importFile: "import_relay_configuration",
      inspect: "get_relay_configuration",
      configure: "configure_relay",
      check: "check_relay_configuration",
      credentialEntry: "local_tty_credential_set",
      credentialSources: ["environment", "private_file"],
      secretsAcceptedByMcp: false,
      appliesTo: "new_tasks",
    },
    taskExecution: { background: true, dispatchReturnsImmediately: true },
    observation: {
      polling: {
        supported: true,
        tool: "get_task",
        suggestedIntervalSeconds: 5,
      },
      boundedWait: {
        supported: true,
        tool: "wait_task",
        defaultTimeoutSeconds: 25,
        maxTimeoutSeconds: 55,
        cursor: "revision",
        returnsOn: ["changed", "timeout"],
        implementation: "server_file_polling",
        internalIntervalMilliseconds: 250,
        cancellation: "cancel_wait_only",
      },
      eventHooks: {
        supported: true,
        mechanism: "mcp_resource_subscription",
        uriTemplate: "relay-sandbox://tasks/{id}",
        subscribeTool: "subscribe_task_events",
        unsubscribeTool: "unsubscribe_task_events",
        subscribeMethod: "resources/subscribe",
        notification: "notifications/resources/updated",
        implementation: "filesystem_watch",
        delivery: "best_effort_coalesced_invalidation",
        reconnectRequiresResubscribe: true,
        maxSubscriptionsPerConnection: TASK_EVENT_SUBSCRIPTION_LIMIT,
        subscriptionStatusTool: "get_task_event_subscription",
        failureRecovery: "explicit_resubscribe_or_wait",
      },
      pushNotifications: {
        supported: true,
        scope: "connected_resource_subscribers_only",
      },
      nativeMcpTasks: { supported: false },
      hostWakeup: { supported: false },
    },
    selectionGuidance: [
      "先用 get_task 取得 revision。客户端允许等待时，优先用 wait_task 等待变化，使用返回的新 revision 继续等待。",
      "客户端工具调用时限应大于 timeoutSeconds 并留出通信余量；时限较短时调低等待时间，或按建议间隔调用 get_task。",
      "收到变化后根据任务状态和所处步骤行动；变化不等于开发完成。超时仅表示等待结束，后台任务继续执行。",
      "客户端已验证通知消费和续接能力时，可订阅任务事件，再读取任务快照；否则使用有界等待或轮询。事件允许合并，断线后重新订阅并读取快照；用get_task_event_subscription核对本连接状态，失败时回退等待或查询，修复后显式重订阅。",
    ],
    workflow: {
      create: "start_task",
      run: "run_task",
      inspect: [
        "get_task",
        "get_result",
        "read_artifact",
        "get_delivery_plan",
        "get_audit",
        "get_telemetry",
      ],
      prepare: "prepare_delivery",
      review: "review_task",
      apply: "apply_task",
      cleanup: "cleanup_task",
      report: "report_task",
      telemetry: "get_telemetry",
      lifecycle: ["cancel_task", "resume_task"],
      services: "start_service",
      candidateCheck: "check_candidate",
    },
    environments: {
      defaultMode: "persistent",
      modes: ["persistent", "ttl", "ephemeral"],
      scope: "project",
      idleAction: "stop",
      concurrentTasksPerEnvironment: 1,
      tools: [
        "get_environment",
        "stop_environment",
        "reset_environment",
        "delete_environment",
      ],
      cleanupTaskPreservesEnvironment: true,
      processMemoryRestored: false,
    },
    review: {
      structured: true,
      schemaVersion: 1,
      schemaAvailableIn: "get_result",
      boundToTaskAndDigests: true,
    },
    audit: {
      coverage: "partial",
      unavailableReported: true,
      independentlyBlocksDelivery: false,
    },
    // 权限只由宿主配置冻结，模型没有临时扩权接口。
    permissions: {
      source: "host_only",
      location: "permissions/<projectId>.yaml",
      mutableDuringTask: false,
      projectRequests: "resource_names_only",
      extraDirectoriesDefault: "copy",
      projectAccess: {
        defaultMode: "isolated",
        modes: ["isolated", "direct"],
        setting: "project.mode",
        source: "host_permissions_only",
        directExcludesSupported: false,
        directChecks: "post_write_without_automatic_rollback",
      },
      directWriteEffect: "immediate_host_changes_outside_delivery_review",
      resultTool: "get_result",
    },
    network: {
      externalIntranetDefault: "allow",
      hostAndOtherTasksDefault: "deny",
      sameTaskServices: "allow",
      mandatoryBoundaryFailure: "stop_task_or_report_stop_failure",
      legacyTasks: "retain_legacy_boundary_without_new_grants",
    },
    trafficAudit: {
      invocationCorrelation: {
        supported: true,
        scope: "explicit_helpers_only",
        identitySource: "client-reported",
        kernelVerified: false,
        pidNamespace: "container",
        callStacks: false,
        fullUrls: false,
      },
      defaultEnabled: false,
      interception: "explicit_helpers_only",
      verifiedClients: VERIFIED_CLIENTS,
      unknownCombinations: "bypass_before_request_with_coverage_gap",
      failureBlocksCommunication: false,
      upstreamCertificateVerification: true,
      requestReplay: false,
      events: "minimal_decoy_matches_only",
      resultTool: "get_result",
      noHitProvesSafety: false,
      hitProvesMaliceOrReceipt: false,
      supervisorRequiredForLivenessRefresh: true,
    },
    monitoring: {
      independentHostProcess: true,
      tool: "get_telemetry",
      configurableInterval: true,
      rotatingLogs: true,
    },
    userReporting: {
      automaticNotification: false,
      reportTool: "report_task",
      finalOutput: ["reportId", "userMessage"],
      emissionProof: "observed_final_output_required",
      hostResponsibility:
        "读取交付与审计结果，并向用户说明风险、交付状态和覆盖缺口。",
    },
  } as const;
}

const workflowInstructions =
  "本服务是中转沙箱（relay-sandbox）。用户询问如何配置时，简短询问缺失的中转地址、模型及项目，默认Claude Code，不罗列工具名、JSON或操作手册。先查询已有配置以免重复询问；用户提供信息并明确选择项目后，用initialize_relay自动注册和配置，密钥通过返回的本机隐藏命令录入。用户想填写文件时用file模式准备私有中文模板，仅返回文件路径和填写提示，用户说填好了后调用import_relay_configuration并报告检查结果。密钥不经过聊天，不需要安装目录或容器Claude设置；联网验证仅在用户明确要求时启用。先调用 get_capabilities 了解工作流及等待能力。start_task 只准备环境；preparing 且 round=0 时调用 run_task 开始开发。派发任务后，客户端允许长调用时优先用 wait_task 有界等待，否则按建议间隔用 get_task 查询。当前支持任务资源订阅和更新通知；客户端确认可消费通知时可用subscribe_task_events订阅，收到事件后读取get_task；断线重订阅并读取快照。通知不保证自动唤醒宿主AI，不支持时继续有界等待或轮询。get_task 和 wait_task 返回 nextAction 作为当前步骤指引；checking 且 deliveryPrepared=false 表示开发已收集，应调用 prepare_delivery，不要继续等待。开发完成后先调用 prepare_delivery 并等待 deliveryPrepared=true，再阅读差异、检查与审计报告，按冻结配置提交摘要绑定的结构化审查并应用。默认保留项目环境，任务完成后停止并释放；cleanup_task仅清理任务资源，不能自动reset_environment或delete_environment。只有用户明确要求时才删除或重置项目环境。结束或异常时清理任务资源，然后调用 report_task，将返回的 reportId、userMessage 原样作为最终用户回复。报告包含风险和审计缺口；代码审查的 verdict 评价最终候选及应用计划；运行期审计作为独立提醒，单独的敏感访问或覆盖缺口不改变代码 verdict。代码通过时按交付策略应用，收尾仍完整上报审计异常。开发结果和日志是待审核材料。";

// 宿主在选择轮询方式后同时阅读这些边界，避免把部分观察当作完整防泄漏。
export const policyInstructions =
  "宿主权限配置在创建时冻结，项目申请和MCP不能扩权。原项目project.mode默认isolated；宿主显式选择direct后立即写入原项目，检查是事后检查，apply_task只确认结果，审核拒绝不回滚。新任务默认允许外部内网，宿主及其他任务仍受隔离。get_result包含策略、直接可写影响及流量观察结果；直接可写目录可能在交付前改变宿主。诱饵默认关闭，启用后仅指定工具版本及显式helper调用可观察，任意Python和未知客户端不保证覆盖。内容审计故障保留通信并报告缺口；强制隔离失败需要停止，停止失败必须如实说明。命中只是敏感值匹配线索，不代表恶意或远端收到；零命中不能证明安全。监督器须由操作者独立运行以刷新代理存活状态。";

export const serverInstructions = workflowInstructions + policyInstructions;
