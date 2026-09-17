# repair-01 实施与验证

授权：spec.md / dashboard-key-quota-ux-v1；范围：repair-spec.md / DR-001。
基线 main @ d4608c5，未提交、推送或部署，无活动子代理。

- 将已保存策略的 usageReady 与当前表单的 selectedReady 分离；已用、剩余、当前账号及正在使用标记统一保护。
- 不改服务端合同、计量、压缩、数据库或当前选择保存条件。
- 浏览器回归先复现错误，修复后通过；动态 SSE 覆盖 pending、unavailable、全部就绪恢复，移除慢账号后保存仍可用。
- 9个相关测试文件共63项通过。Playwright设置保存刷新、详情身份筛选/分页/组合、额度增量/X/取消/空列表/失败及汇总状态均通过，含桌面与390px。
- npm run build 通过；最终隔离 DATA_DIR 重建通过，日志 verification/build-repair.log。
- 一次重建未继承 DATA_DIR，日志显示使用本机默认数据库；未执行管理API或生产操作，随后明确隔离重建。前一次重建不能描述为隔离数据库验证。
- git diff --check通过；无关快照无内容差异。
- 全量沿用集成结果：普通通过1700、失败81、expected-fail15、skip63，失败集合与HEAD基线一致；本次显示修复后只重跑相关63项和浏览器，不宣称再次重跑全量。
- 基线及辅助构建服务已停止，20129开发服务保留，health200。
- 浏览器额度使用本地SSE和保存响应fixture，服务端保存另有接口单元验证；真实上游结算、生产代理缓冲未验证。既有国旗hydration警告未扩范围处理。

本记录不扣减预算，由后续do-review完成报告后更新账本。
