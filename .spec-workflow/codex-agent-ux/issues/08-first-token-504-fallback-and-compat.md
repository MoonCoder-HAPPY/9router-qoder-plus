# 08 — 首 token 504 兜底与兼容性收口

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §16.6）
- **Problem source**：线上 10 次 `timeout retry limit reached after 3/3`；`previous_response_id` 被静默忽略
- **What to build（端到端行为）**：504 首 token 超时时先换账号、再按倍数延长预算（不降档），最终成功或按映射返回 `server_is_overloaded`；`previous_response_id` 非空时显式返回 `invalid_prompt`；item id 稳定
- **Delivery goal**：把"重试 3 次就失败"变成"自愈或明确报错"
- **Modification scope**：
  - `open-sse/executors/qoder.js`：504 兜底策略（策略与倍数读 `codexCompat`）
  - `open-sse/translator/request/openai-responses.js`：`previous_response_id` 显式拒绝
- **Acceptance criteria**：换账号优先于延长预算（断言调用顺序）；不降档；策略=off 时行为与现状一致；显式拒绝断言通过
- **Dependencies**：05
- **Blocked by**：05
- **Status**：ready-for-agent
- **Priority**：P1
- **Blocks delivery**：否
- **Can run in parallel**：—
- **Parallel boundary**：只动 504 路径与请求翻译的兼容性分支
- **Input context for spec-do**：spec §16.6；prior art `tests/unit/qoder-first-token-timeout.test.js`