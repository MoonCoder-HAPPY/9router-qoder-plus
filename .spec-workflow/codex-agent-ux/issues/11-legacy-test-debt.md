# 11 — 历史遗留测试债务清零（deferred）

- **Parent / Source**：`codex-agent-ux@v1` + `amendments/01-ac-baseline-scope.md`
- **Problem source**：仓库长期存在 70 个失败用例（`tests/__baseline__/known-fails.txt`），其中 55 个不在上游基线内
- **What to build（端到端行为）**：`node tests/scripts/check-baseline.mjs --update` 后基线收敛为 0 条；golden 快照重录且稳定
- **Delivery goal**：测试从"基线门禁"回到"全绿门禁"
- **Modification scope**：`cursor-agent-proto`（35）、`oauth-cursor-auto-import`（8）、translator normalization（4）、golden 快照（4）、db-concurrent（3）及其余零散 16 条
- **Acceptance criteria**：全量 `vitest run` 无 failed；基线文件为空；CI 步骤可直接改为全绿门禁
- **Dependencies**：无（独立于 01–10）
- **Blocked by**：—
- **Status**：`deferred`（本轮不做；需用户显式重开）
- **Priority**：P3
- **Blocks delivery**：否
- **Can run in parallel**：是
- **Parallel boundary**：只动 `tests/**`，不得为过测而改生产代码语义
- **Input context for spec-do**：`amendments/01-ac-baseline-scope.md`；`tests/__baseline__/known-fails.txt`；复现：`node tests/scripts/check-baseline.mjs`