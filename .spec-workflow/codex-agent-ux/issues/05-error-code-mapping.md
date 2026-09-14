# 05 — 错误码映射（HTTP + 流内）

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §9.2、§13、§16.8）
- **Problem source**：Codex 只认 5 个语义 code；现状混着 408/429/5xx，且压缩只在撞 400 后被动发生
- **What to build（端到端行为）**：上下文类 → `context_length_exceeded`（客户端自动压缩重试）；额度耗尽 → `insufficient_quota`；排队/限流 → `rate_limit_exceeded` + 钳制后的 `retry_after`；过载/504 用尽 → `server_is_overloaded`；非法体 → `invalid_prompt`；错误在任何路径都不落成助手正文
- **Delivery goal**：失败可自愈，且不再污染会话历史
- **Modification scope**：
  - `open-sse/config/errorConfig.js`：规则表补齐 code 映射与 `retry_after` 钳制（`codexCompat.rateLimitRetryAfterCapMs`）
  - `open-sse/executors/qoder.js`：分类器输出标准 code；HTTP 与流内两路径一致
  - `src/sse/services/auth.js`：额度耗尽路径返回 `insufficient_quota`
- **Acceptance criteria**：5 个 code 的两种路径断言通过；`retry_after ≤ 120s`；错误路径 `status="error"`、token=0；无「助手正文 + stop」伪装
- **Dependencies**：无（与 01 为并行的前置性工作）
- **Blocked by**：—
- **Status**：ready-for-agent
- **Priority**：P0
- **Blocks delivery**：是
- **Can run in parallel**：是（与 03/04 并行）
- **Parallel boundary**：只动 errorConfig/qoder 分类器/auth 额度分支
- **Input context for spec-do**：spec §9.2 映射表；prior art `tests/unit/qoder-context-overflow.test.js`