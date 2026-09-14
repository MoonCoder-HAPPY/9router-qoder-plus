# 04 — reasoning 保真与最近一轮往返

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §9.3、§10.2、§16.4）
- **Problem source**：reasoning item 缺 `encrypted_content`；summary 内塞全量 CoT 导致历史膨胀；跨轮连续性仅靠文本回填
- **What to build（端到端行为）**：Codex UI 能实时展开思考；下一轮请求只回填最近一轮 CoT，历史轮次不再重复注入全文；`encrypted_content` 可被 Codex 原样回传并被我们解回
- **Delivery goal**：思考可见 + 上下文不因 reasoning 膨胀
- **Modification scope**：
  - `open-sse/translator/response/openai-responses.js`：`item_id` 全程一致且 ≤64 字符；`summary_index` 单调；每段 `part.added` 仅一次；`output_item.done` 携带全文 `summary` 与自有 `encrypted_content`
  - `open-sse/translator/request/openai-responses.js`：仅最近一轮 assistant 的 reasoning 还原为 `reasoning_content`；更早轮次不注入全文；非法 `encrypted_content` 安全降级
  - 载荷：`base64url(JSON{v:1,model,ts,coh,summaryLen})`，不含 CoT 全文与凭据
- **Acceptance criteria**：事件序列断言通过（含文本先到、工具调用、断连分支）；最近一轮往返断言通过；历史不注入全文断言通过；非法串不炸
- **Dependencies**：无（与 01 为并行的前置性工作）
- **Blocked by**：—
- **Status**：ready-for-agent
- **Priority**：P0
- **Blocks delivery**：是
- **Can run in parallel**：是（与 03/05 并行）
- **Parallel boundary**：只动两个 translator 文件及其测试
- **Input context for spec-do**：spec §9.3 事件契约；`__test__` 内部导出可测；prior art `tests/translator/bugs-codexCli-responses.test.js`、`tests/unit/responses-tool-order.test.js`