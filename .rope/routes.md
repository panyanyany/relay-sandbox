# 执行环境与文档路由

Worktree setup: host-managed

- 用户已确认沿用当前宿主管理的工作目录开发与测试。
- 2026-11-02 用户明确授权初始化 Git 并创建首次提交；继续使用当前工作目录。后续 commit 或 push 仍需用户明确要求，不自动推送。
- 行为策略已确认基线：issues/behavior-policy/grill-decisions.md。
- 模块定位：issues/behavior-policy/map.md。
- 项目约束：../AGENTS.md；语言、构建与测试入口：../package.json。
- 架构与运行文档沿用 ../devdocs/，本层不复制现有文档。
- 实施须中文注释、源码和测试文件少于 500 行；完成后同步 devdocs、索引和结构。
- 检查：pnpm lint && pnpm check && pnpm test；完成后 pnpm build。
- 集成证据：pnpm test:docker、pnpm test:e2e；真实接口用已授权范围，证据写入被忽略的 .local/evidence/。
