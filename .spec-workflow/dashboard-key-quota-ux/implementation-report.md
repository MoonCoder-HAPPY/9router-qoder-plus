# 实施记录

授权：spec.md，dashboard-key-quota-ux-v1，当前会话确认自动实现/验证/审查；不自动提交。
基线：main @ d4608c5b3f57ee8c1ac63829534dca193001dc9f；原工作区干净，开始实施前只有本需求的工作流文档。
Auto-commit allowed: no。无推送/部署授权。
当前阶段：最终复审 complete / can ship，本规格目标满足。修复轮次：1；reserved cycle: none；completed cycles: 1；remaining: 1。repair-01由review-reports/02-quota-summary-review.md完成后扣减一次。
任务：01 完成；02 完成；03 完成；04 完成。两位实现代理均已完成并关闭，无未完成文件所有权。
协调：主代理先做设置整理，Key 路径与额度路径可按不重叠文件内部协作；额度 03/04 串行；主代理负责翻译、集成、浏览器验证和审查。
下一自动阶段：无，停止自动循环。修复实施见implementation-reports/02-summary-readiness.md，最终审查见review-report.md。保留未提交改动供用户审阅。

## 初步验证

- 01 展示回归先红（1 failed / 1 passed），实现后 codex-dashboard-surfaces、codex-compat、codex-compat-settings 共 11 passed。
- Playwright 已操作两项设置并保存/刷新确认，桌面和 390px 截图位于 verification；原有 ProfilePage 语言国旗 SSR mismatch 单独记录，不计新增异常。
- 独立 HEAD 归档基线：1669 passed / 81 failed / 15 expected fail / 63 skipped。隔离 DATA_DIR、RUN_REAL=0，不调用真实提供商。
- 基线归档及日志在系统临时目录 `9router-key-ux-baseline-20260917` 和 `9router-key-ux-baseline-results.json`。
- 本地隔离开发服务器 http://127.0.0.1:20129，PID 15620，DATA_DIR 为系统临时目录 `9router-key-ux-browser-data-20260917`，没有生产凭证。
- 内部代理：02 Ramanujan / 01a0ad43-69ad-7c40-9115-c236652cf6f9；03/04 Epicurus / 01a0ad43-6a0e-7af2-99cc-c1ea1a91ed6d。

## 集成验证与自查

- 全量再次执行：新增 31 项断言通过，失败断言集合与基线完全相同（81），无新增失败。基线普通通过 1669，当前普通通过 1700；JSON numPassedTests 含 15 项 expected-fail，分别为 1684/1715。既有失败套件包括缺失依赖/目录、空测试与 Windows 临时目录清理 EPERM，不声称全库全绿。
- 首轮新增失败是 Credits 旧测试硬编码 10 列；按新 Key 列同步为 11 列并覆盖 loading/error/empty，第二轮恢复基线失败集合。
- `npm run build` 成功；`git diff --check` 通过。
- 余额取消信号在真实 getQoderUsage 路径补传，测试先红后绿；额度相关 3 文件 14 项通过。
- Playwright 三份可重跑脚本位于 debug/：settings 保存刷新和窄屏，usage 真实隔离 SQLite + API 身份筛选/分页组合，quota 本地 SSE fixture + 真实弹窗行为。
- quota 浏览器验证：未选慢账号尚在加载时可保存；输入不被增量结果覆盖；X 同步取消勾选；取消恢复；空列表禁存；保存 payload 正确；所选失败禁存；关闭终止读取。保存成功响应使用隔离 fixture，真实落库校验另由 incremental-quota 测试覆盖。
- 截图：verification/settings-{desktop,mobile}.png、usage-{desktop,mobile}.png、quota-partial-desktop.png、quota-mobile.png。
- 原 HEAD 临时服务器重复观察到 ProfilePage 国旗 hydration mismatch；本次保留并记录既有问题，不扩展修复全局语言系统。
- 测试运行自动添加的 golden-url-header snapshot 已恢复原内容；未改无关快照。
- Next dev 自动生成根 AGENTS.md，已识别为工具产物并保留，非业务需求改动；不将其冒充用户修改。
- 自查 Standards：复用现有组件/图标/JSON 仓库，无新增依赖和架构性重构。Spec：四条链路均已实现并有行为验证。Scope：未改压缩、未重置额度、未操作生产。
- 风险：真实上游结算与生产代理缓冲未验证；旧详情无法补全已明确接受。没有提交、推送或部署。

## 最终审查任务图

- R1 Standards：只读相对基线的代码及新增文件，检查命名/重复/复杂度/生命周期、安全边界，输出具体文件行号发现；禁止写业务代码；无依赖。
- R2 Spec：只读 requirements/spec/issues、实现和测试，核对数据身份、分页、额度保存、流式异常与范围，输出验收遗漏；禁止写业务代码；无依赖。
- R3 主代理验收与聚合：复核截图、测试差异、生产构建服务健康与鉴权，依赖 R1/R2 完成。无 must-fix 才 can ship；否则保留发现并转 fix-review，最多 2 轮。
