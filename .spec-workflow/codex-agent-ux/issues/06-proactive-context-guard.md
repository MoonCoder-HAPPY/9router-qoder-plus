# 06 — 主动上下文准入

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §16.5、§12.2）
- **Problem source**：Codex 本地 tokenizer 低估（线上真实 318k 输入、4 次 >1M 溢出 400）→ 只有撞墙才知道
- **What to build（端到端行为）**：超阈值请求**未打上游**即返回 `context_length_exceeded`（附估算值与限额），Codex 压缩后重试成功；开关关闭时行为与现在一致
- **Delivery goal**：把"撞墙失败"变成"提前无损压缩"
- **Modification scope**：
  - 新增保守估算工具（`open-sse/utils/`），CJK 感知；与 `computeAutoCompactLimit` 比对
  - `open-sse/executors/qoder.js` 入口接入；同一回合连续主动拒绝设上限（防止死循环）
  - 记录 `admissionRejectReason` 与 `contextPeakEstimate`
- **Acceptance criteria**：超阈值未打上游（断言上游 fetch 未被调用）；`status="error"`、token=0；开关关闭时请求照旧走上游；连续拒绝上限生效
- **Dependencies**：02、05
- **Blocked by**：02、05
- **Status**：ready-for-agent
- **Priority**：P0
- **Blocks delivery**：是
- **Can run in parallel**：—
- **Parallel boundary**：只动估算工具 + qoder 入口 + 记录字段
- **Input context for spec-do**：spec §10.1/§12.2；阈值公式 `clamp(窗口×0.5,120k,500k)`