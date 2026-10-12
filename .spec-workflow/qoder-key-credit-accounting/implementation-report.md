# 实现记录

Authority: user-confirmed-in-current-conversation。输入：requirements.md 和当前会话批准的示例。

## 授权与基线

2026-10-12，main，固定起点 0f8ed4960fc4faf43a2cca6ebfc797fd483b1486。用户选择保留旧 debug/verification/AGENTS.md；当前新增文件仅为本需求记录。沿用用户不自动提交的偏好，只完成实现、验证和内置自审。本轮不启用跨阶段 Goal Mode，不推送或部署。

## 协作与串行执行顺序

共享额度函数、保存事务和展示强耦合，由主代理串行实现，无子代理。

1. 用量与预留：共享 policy、quota-options、CC-SWITCH、路由鉴权。通过已有公开函数和端点锁定真实 Key 扣费与多账号汇总。
2. 保存：Key PUT/repository 与前端编辑表单。依赖 1；校验新额度下限、上限和并发更新，保留历史 ledger。
3. 平台展示与文档：与 1/2 使用同一计算结果；串行集成浏览器、相关测试、Lint、构建和 Standards/Spec/Scope 三轴自审。

允许修改：本需求相关 policy、Key API/repository、CC-SWITCH、额度弹窗与中文说明、回归测试、README 和本目录报告。禁止：用户既有临时文件、生产数据、无关上下文/流式模块。

## 测试入口

已有公开 evaluateApiKeyProviderCreditUsage / validateQoderPolicyAllocation、真实临时 SQLite、PUT /api/keys/[id]、POST /api/usage、GET /user/balance、quota-options SSE 和浏览器表单。期望值直接采用用户示例，不模拟核心业务计算。仅模拟 Qoder 上游 fetch；数据库与业务代码真实执行。

## 当前状态

需求实现完成。3 项最初失败回归已修复；13 个相关测试文件、102 项测试通过，真实本地 SQLite/HTTP 和浏览器验证用户批准的额度调整、共享隔离、并发保存及取消行为。生产构建、TypeScript、131 页面生成通过；新后端/测试 Lint 通过，弹窗保留经 HEAD 复核的既有 Lint 基线问题。

最新完整记录：[implementation-reports/01-key-allocation-accounting.md](./implementation-reports/01-key-allocation-accounting.md)。根因与限制见 diagnosis-report.md。隔离本地服务已经停止，debug/verification 中保留可复跑脚本和截图；没有提交、部署或改写生产数据。

## 发布授权（2026-10-12）

用户最新指令“部署进行生产替换然后push改动”明确授权本轮提交、生产替换和推送，取代上方实现阶段的不发布限制。发布只包含本次已验证业务代码、测试、README/中文文案和四份需求/诊断/实现报告，排除全部 debug、verification、临时数据库及 AGENTS.md。生产保留当前版本和 v39c 回滚容器，切换前备份数据，切换后验证健康与两个真实余额端点；成功后推送 origin/main。发布过程不重算生产历史账本。

该轮发布已完成：290c68c；邮箱验证后GitHub main同步，生产检查通过。发布证据保留在verification/release-result.md。

## 最新补充实现

用户随后要求展示官方消费后的实际可用，并选择共享余额先到先用。输入：[amendments/01-actual-availability.md](./amendments/01-actual-availability.md)。本轮基线290c68c，新增实际可用字段、未知状态、查询时间、列表SSE、30秒自动/焦点/手动刷新、弹窗编辑保留和CC-SWITCH同口径余额。

最新完整报告：[implementation-reports/02-actual-availability.md](./implementation-reports/02-actual-availability.md)。14文件/111测试、构建/TypeScript、实际浏览器30秒刷新、失败恢复和移动布局通过；原有前端Lint基线已记录。补充改动保留在本地，未自动提交、推送或部署；当前生产仍为290c68c。

## 补充版本发布授权

2026-10-12，用户回复“部署并 push”，授权提交上述实际可用补充改动、生产替换和GitHub推送。正式改动与两份补充报告纳入提交，全部debug/verification/AGENTS.md继续排除。发布将额外保留290c68c回滚容器、此前回滚容器及v39c，切换前备份生产数据；验证平台实际可用API、两个余额端点的实际余额/未知状态和公网健康。
