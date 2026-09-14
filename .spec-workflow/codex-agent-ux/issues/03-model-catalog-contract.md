# 03 — 模型目录契约：`/v1/models` 输出 Codex 原生 `models[]`

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §9.1、§16.3）
- **Problem source**：Codex 只解析 `{"models":[…ModelInfo…]}`（5s 超时）；我们只发 `data` → Codex 退回 272k 兜底元数据，导致压缩阈值、reasoning 档位、多模态能力全部失真
- **What to build（端到端行为）**：Codex（CLI/App）读取目录后不再打印 `Unknown model … fallback model metadata`；上下文窗口与压缩阈值取真实值；App 模型列表按 `visibility` 呈现；图片模型能力正确
- **Delivery goal**：一处修复同时解决"上下文适配"与"能力探测"两大症状
- **Modification scope**：
  - `src/app/api/v1/models/route.js`：构造 `models[]`（与 `data` 并存），`slug/display_name` 用公开 ID；档位模型 `visibility="hide"`
  - 复用 `decorateQoderModelsForPublic` 的 `internalId/publicId/contextLength/isVL`；阈值走 `codexCompat.computeAutoCompactLimit`
  - `data[].capabilities.vision` 按 `is_vl` 修正
  - 内部 key/邮箱/额度绝不出现在响应
- **Acceptance criteria**：契约快照测试通过（必填字段齐全、nullable 显式 `null`）；`DeepSeek-Flash` → `context_window=1000000`/`auto_compact_token_limit=500000`；`Lite` → `["text"]`；响应 P99<1s
- **Dependencies**：02
- **Blocked by**：02
- **Status**：ready-for-agent
- **Priority**：P0
- **Blocks delivery**：是
- **Can run in parallel**：是（与 04/05 并行）
- **Parallel boundary**：只动 models 路由与其目录构造/测试
- **Input context for spec-do**：spec §9.1 示例与规则；Codex `ModelInfo` 必填字段清单（`codex-rs/protocol/src/openai_models.rs`）；prior art `tests/unit/qoder-public-models-api.test.js`