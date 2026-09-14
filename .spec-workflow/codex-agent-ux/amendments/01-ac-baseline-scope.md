# Amendment 01 — 验收口径改为"无新增失败"基线门禁

- **Amendment ID / Title**：`01-ac-baseline-scope` — 把 ticket 01 的验收从"测试全绿"收敛为"无新增失败 + 本需求测试全绿"
- **Date**：2026-09-15
- **Source**：用户决策（当前会话 Q-D 选项 A），决策来源 `user-confirmed-in-current-conversation`
- **Prior artifacts read**：`requirements.md`、`spec.md`、`issues/01-fix-failing-tests-and-ci.md`
- **Canonical paths updated**：`spec.md`（§16.1）、`issues/01-fix-failing-tests-and-ci.md`（Scope + Acceptance criteria）、新增 `issues/11-legacy-test-debt.md`

## 变更摘要

实测仓库仍有 70 个失败用例，其中仅 15 个在既有 `tests/__baseline__/known-fails.txt` 内，其余 55 个为历史遗留（`cursor-agent-proto` 35、`oauth-cursor-auto-import` 8、translator normalization 4、golden 快照 4、db-concurrent 3 …），与本需求无关。原 AC「全绿」会把本轮工期拉进无关模块。

新口径：
- 门禁命令 `node tests/scripts/check-baseline.mjs`（默认模式：仅对**新增失败**报错；`--update` 重写基线）；
- 基线 `tests/__baseline__/known-fails.txt` 以本次实测重写为 **70 条**；
- 本需求相关测试（translator / qoder / responses / models）必须全绿；
- 历史遗留债务转入 `issues/11-legacy-test-debt.md`（状态 `deferred`）。

## Ticket 变更

| 票 | 变化 |
| --- | --- |
| 01 | 修改（Scope 增加 `tests/scripts/check-baseline.mjs`；AC 改为基线门禁） |
| 11 | 新建（`deferred`：历史遗留测试债务清零） |

- **Dependency changes**：无（11 不阻塞 01–10）
- **Testing decision changes**：CI 门禁由"全绿"改为"基线门禁"；新增脚本与 workflow 步骤
- **Implementation status impact**：ticket 01 可继续并已实质完成（等待提交）；02/04/05 仍可并行
- **Goal Mode impact**：`enabled for this amendment`（用户 2026-09-15 于当前会话明确授权"后续自动授权 Goal Mode"，作为本 spec 及其后续修订的持续授权；范围变更与生产动作仍需单独决策）
- **Open questions / accepted risks**：接受"70 条历史失败保留"作为本轮风险；快照漂移（golden 快照被测试运行重写）已记录在 11