# 第 1 轮修复规格：汇总就绪状态

Authority: local-spec-workflow
Source review: review-reports/01-initial-review.md / DR-001
Goal authorization: spec.md / dashboard-key-quota-ux-v1；reserved cycle: repair-01；completed: 0；remaining: 2。

## 问题与目标

修复前端把当前表单的 selectedReady 用于已保存策略汇总的问题。保存继续只等待当前所选账号；已用/剩余/活跃账号三项汇总在已保存策略涉及的账号未完整返回时不得显示确定值。

## 范围与根因

仅修改限制弹窗的汇总就绪派生状态和对应显示，补充浏览器与测试；若需要独立纯函数，仅包含账号集合就绪判断。禁止改计量、路由、数据库、额度策略、Key历史和权限。不增加新业务规则。

## 前后端、数据与错误

前端用已保存策略 connectionIds、当前账户行状态和 keyUsage.unavailableConnectionIds 独立判断汇总就绪，不复用表单 selectedReady。三项依赖完整数据的字段统一显示 Not ready。已知 limit 正常显示。保存按钮依然用当前所选 readiness。
后端/API/数据模型/权限变更：不适用，已有未知标記足够。无需迁移或修改保存合同。

## 验收与验证

1. 已保存 slow/fast，slow pending、fast ready；移除 slow 后保存可用，汇总已用、剩余、活跃三项仍尚未就绪。
2. slow 后续失败时保持未知，不显示确定的 Fast 为当前账号。
3. slow 后续完成后，汇总按完整旧策略显示；新分配保存流程不受影响。
4. 取消仍恢复选择，保存无原账号等待回归；原14项额度测试及设置/历史测试继续通过。
5. Playwright 使用动态 keyUsage 和受控逐帧流真实复现，不再只固定汇总值；构建复验。

## 执行与回滚

本轮范围小且同一组件，主代理串行实施，不拆修复票据。先补可失败的浏览器回归，再改UI、复测、重建，进入只读复审。无外部变更，无数据库回滚；代码可回退此修复。未变更产品需求，无需重新询问。
下一自动阶段 spec-do。运行计数仍由 implementation-report.md 记录，复审完成后扣减一次。
