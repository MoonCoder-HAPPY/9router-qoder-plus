# 额度口径实现完成记录

输入：当前会话批准的例子和 requirements.md。Authority: user-confirmed-in-current-conversation。

main，基线 0f8ed49，改动保留在工作区，无提交。Goal Mode 未启用；没有自动发布授权。旧 dashboard-key-quota-ux debug/verification 与 AGENTS.md 保持原样。

## 执行结果

主代理串行完成，无子代理。任务1（共享用量、预留、后台汇总、CC-SWITCH与鉴权）、任务2（事务校验与表单预览）、任务3（中文说明、README、测试与自审）均完成。

涉及文件：src/shared/services/apiKeyPolicy.js、qoderKeyAllocation.js、ccSwitchUsage.js；src/lib/ccSwitchUsageRequest.js、db/repos/apiKeysRepo.js；src/app/api/keys/[id]/route.js、quota-options/route.js；src/sse/services/auth.js；ApiKeyRestrictionsModal.js；public/i18n/literals/zh-CN.json；README.md；新增两个 qoder-key 回归文件，更新 api-key-policy 和 auth 旧测试以使用批准的自身扣费口径。

## 验证与本地服务

13 文件 / 102 测试通过。两个新增文件覆盖函数契约6项和真实SQLite/HTTP集成6项。生产构建、TypeScript、131静态页面生成通过。后端/测试Lint通过；弹窗既有Lint错误和警告已对HEAD基线核实，本次未引入新的Lint问题。diff/语法检查通过。

browser-check.cjs 启动隔离本地构建服务20132，只模拟外部Qoder额度响应，真实运行账户读取、表单、Key保存、数据库和余额接口。实际观察预览1200/2000剩余800、低于1200阻止、等于1200可保存、取消不改动、保存后列表/接口同步、手机390px无横向溢出。服务已停止，临时数据库已移除。浏览器页面错误=[]。

## 自审

- Standards：串行独立检查数据逻辑、事务、UI状态与本地指导。预算校验提取共享服务，避免数据库repository依赖Next路由；前后端共享持久化消耗与预留函数；未知额度不参与扣费计算。现有弹窗effect规则属于旧基线，未扩大修改。
- Spec：独立对照用户例表，当前分配值、用量保留、下限拒绝、共享隔离、充值和取消/保存行为均有实际测试证据。
- Scope：未修改上下文压缩、流协议、生产数据、用户旧文件或原账户移除/显式重置入口。已用/剩余额字段未互换。无新增发布操作。

## 剩余风险

旧账缺少精确归属证据时不自动恢复；上游余额快照无法防止外部客户端同时消费。既有完整仓库测试基线不作为本次通过宣称，本次相关套件已通过。debug/verification保留作为复验材料，其中首次失败的临时数据库删除被审批拦截后可恢复移动至 debug/failed-browser-database/，约36KB，后续无需纳入提交。

已形成可审阅改动，可进入最终交付审查；未提交、推送或部署。
