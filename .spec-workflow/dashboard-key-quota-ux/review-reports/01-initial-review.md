# 首轮最终审查

Authority: local-spec-workflow
授权源：spec.md / dashboard-key-quota-ux-v1。读取 requirements.md、spec.md、issues/01-04、implementation-report.md、相对 d4608c5 的未提交差异及新增业务文件；无 amendment。

## 结论

Completion: mostly complete
Ship Decision: fix before ship
Standards 轴无 must-fix；Spec 轴 DR-001 待修复。四项主流程、构建、浏览器和接口鉴权通过，不代表异常组合均已通过。

## DR-001 / P2 / 必须修复

汇总就绪与汇总数据采用不同账号集合。ApiKeyRestrictionsModal.js:133 的 selectedReady 来自当前表单；293/298 的 keyUsage 用量、余额来自服务端已保存策略；303 的活跃账号没有就绪保护。

复现：已保存 slow、fast，各分配 100、基线 100；slow 加载中，fast 返回 90。点击 X 移除 slow 后 selectedReady 为 true，但旧 keyUsage 仍含 unavailableConnectionIds=[slow]。页面显示 10/200、190、Fast；slow 后返回 80 又变成 20/200、180、Slow。管理员看到的是不完整汇总，违反未知不得显示确定值的规格。服务端保存校验未被绕过。

根因不是后端 null 转 0，后端现已标记未知；前端用当前选择就绪代替了已保存汇总就绪，且现有浏览器 fixture 使用静态 keyUsage 没覆盖此组合。

期望：保存仅等待当前所选；旧策略汇总分别检查其完整账号数据及未知标记。未完整时已用、剩余、活跃账号均显示尚未就绪，额度上限等已知数据可以显示。

## 已执行审查

R1 Huygens / 01a0ad54-c66d-70f1-a1ca-2b570b6222e0：Standards 只读审查，无必须修复项；5文件30测试通过。R2 Mill / 01a0ad54-c6c3-72f2-9311-9a2f4deaf0bf：Spec只读及内存复现确认 DR-001。主代理复核定位与截图/API证据。两位代理未修改文件。

生产构建隔离实例 127.0.0.1:20132：health 200；未鉴权详情/流 401；开启空策略 400；流返回 snapshot/complete。未接触生产服务器。全量普通通过1700、既有失败81、expected-fail15、skip63，失败断言无新增。

## 风险与流转

既有全库测试失败、ProfilePage国旗hydration警告、旧数据无法补全已单独记录；生产代理缓冲仍待部署后验证。
Goal Mode 预留修复轮次 repair-01；已完成0，剩余预算2（复审完成才扣减）。下一阶段 fix-review 再 spec-do；不提交、不推送、不部署。
