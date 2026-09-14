# 09 — 可观测：指标与用量准确

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §7.2、§10.3、§16.9）
- **Problem source**：管理员无法判断 reasoning/压缩/上下文峰值；错误路径曾出现假 token
- **What to build（端到端行为）**：请求详情可见 `reasoningEvents`、`compactionTriggers`、`contextPeakEstimate`、`admissionRejectReason`；usage 的输入/输出 token 准确；关键路径日志可 grep
- **Delivery goal**：让灰度期有据可查，问题可定位
- **Modification scope**：
  - `open-sse/handlers/chatCore/requestDetail.js`：新增指标字段
  - `src/app/(dashboard)/dashboard/usage/**`：详情面板展示（沿用脱敏）
  - 关键路径日志前缀统一（准入拒绝/压缩触发/续跑/504 兜底）
- **Acceptance criteria**：详情面板可见 4 个指标；错误路径 token=0 断言；日志可 grep 到四类事件
- **Dependencies**：03、05、06、07
- **Blocked by**：03、05、06、07
- **Status**：ready-for-agent
- **Priority**：P2
- **Blocks delivery**：否
- **Can run in parallel**：—
- **Parallel boundary**：只动指标落库与 UI 展示
- **Input context for spec-do**：spec §10.3；现有 `requestDetails` 记录结构