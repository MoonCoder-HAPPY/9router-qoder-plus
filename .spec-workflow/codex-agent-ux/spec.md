# Spec — Codex Agent 体验改造（codex-agent-ux@v1）

## 0. Goal Mode 元数据（本 spec 版本专属）

| 项 | 值 |
| --- | --- |
| Spec ID | `codex-agent-ux@v1` |
| Amendment ID | 不适用（首版，无修订） |
| Artifact root | `.spec-workflow/codex-agent-ux/`（仓库根 `C:\Users\jingdan\Desktop\9router\repo`） |
| Authority | `local-spec-workflow`（无外部 tracker 作为唯一权威源） |
| Decision source | `user-confirmed-in-current-conversation` |
| Decision date | 2026-09-15 |
| Supersedes | 无 |
| Superseded by | 无（后续修订将写入 `amendments/NN-*.md` 并更新本表） |
| **Goal mode** | **enabled for this spec and its amendments**（用户 2026-09-15 明确授权"后续自动授权 Goal Mode"；范围变更/生产动作仍需单独决策） |
| Goal target | 工单 01–10 全部实现 + 验证通过 + `do-review` 无 must-fix 发现 + 达到 Ship Decision: can ship |
| 最大自动修复轮次 | 2（达上限即暂停汇报） |
| 自动提交授权 | 允许在分支 `feat/codex-agent-ux` 上自动提交；**禁止**触碰 `main`、禁止 force-push、禁止开 PR；分支推送仅在验收通过后执行 |
| 运行期计数归属 | 自动修复轮次的运行期计数由 `implementation-report.md` 维护，本元数据只记录授权 |

**强制暂停条件**（Goal Mode 不豁免，命中即停下并提问）：需要新的产品/业务/数据/权限/灰度/验收决策；实施将超出本 spec 范围；需要切分支、stash、reset、rebase、强推等破坏性 git 操作；出现无法归类的新增 dirty 文件；验证失败且继续需接受风险或改变预期；review 发现需要改范围而非范围内修复；**任何生产或对外可见动作（含生产容器切换）**；达到最大自动修复轮次。

---

## 1. 用户视角的问题

我在 Codex（App/CLI）里通过 9router 用 Qoder 的模型（DeepSeek-Flash 等）干活时：
1. 看不到模型的思考过程，界面里只有正文；
2. 长会话里上下文行为不可预期——有时突然报"上下文超限"，有时首 token 卡很久最后失败，agent 还会在"我先看一下…"之后停住不动。

## 2. 用户视角的解决方案

1. 思考过程在 Codex 里正常显示、可展开；
2. 长会话在**真到上限之前**就被提前、无损地压缩（由 Codex 自己压缩，我们不篡改历史）；
3. 失败能自愈：上下文类错误让客户端压缩重试，限流/过载让它退避，首 token 超时先换账号再延长等待；
4. "宣布即停"自动接续一次，会话不中断；
5. 运维侧能看见 reasoning/压缩/上下文峰值等指标，且发布可灰度、可回滚。

## 3. 背景与目标

**背景**：经 openai/codex 源码级调研 + 线上取证，确认三个根因：
1. `/v1/models` 只返回 `{"data":[…]}`，而 Codex 只解析 `{"models":[…ModelInfo…]}`（5s 超时）→ 采用兜底元数据（`context_window=272000`、`effective_context_window_percent=95`、`supported_reasoning_levels=[]`、`auto_compact_token_limit=None`）；
2. reasoning item 缺 `encrypted_content`，且 summary 内塞入完整 CoT 导致历史膨胀；
3. 错误码未按 Codex 语义映射（只认 `context_length_exceeded` / `insufficient_quota` / `rate_limit_exceeded`(带 retry_after) / `server_is_overloaded` / `invalid_prompt`），压缩时机又由 Codex 的低估 tokenizer 决定 → 线上出现真实 318k 输入、4 次 >1M 溢出 400、10 次 504 重试耗尽。

**目标**：在**不改 Codex 客户端**的前提下，通过服务端协议保真与元数据修正，让思考可见、上下文可预期、失败可恢复、会话连续、可观测可回滚。

## 4. 非目标

- 不合并上游 `decolua/9router` 0.5.75（235 文件差异）——另立需求。
- 不改动 Codex 客户端，不 fork Codex。
- 不实现 OpenAI/Azure 专用的 `/v1/responses/compact` 远程压缩协议（Codex 对非 OpenAI provider 走本地压缩）。
- 不做 Dashboard 信息架构重构（仅新增配置区与请求详情指标）。
- 不处理：钉钉 Webhook SSRF、Gemini/Antigravity OAuth 环境变量文档、镜像瘦身与 `._*` 清理、20128 端口治理（见 requirements.md 第 12 节）。

## 5. 用户故事

1. 作为 Codex 用户，我希望模型目录里显示真实上下文窗口，这样上下文仪表与压缩时机可信。
2. 作为 Codex 用户，我希望思考过程在 UI 中可见可展开，这样我能判断 agent 是否走对方向。
3. 作为 Codex 用户，我希望长会话在接近上限前被自动压缩，而不是撞到 400 才失败。
4. 作为 Codex 用户，我希望上下文类错误能让 Codex 自动压缩重试，不污染我的会话历史。
5. 作为 Codex 用户，我希望限流/过载错误带上退避提示，客户端能优雅重试。
6. 作为 Codex 用户，我希望首 token 超时先换账号再延长等待，而不是 3 次后直接失败。
7. 作为 Codex 用户，我希望 agent 说完"我先查一下…"后自动继续执行，而不是停住等我催。
8. 作为 Codex 用户，我希望在排队等待期间连接不被掐断（既有 keep-alive 能力保持）。
9. 作为 Codex 用户，我希望图片类请求按模型真实能力处理（能收图就收、不能收就明确报错）。
10. 作为 9router 管理员，我希望这些阈值与开关可配置、有安全默认值。
11. 作为 9router 管理员，我希望请求详情能看到 reasoning 事件数、压缩触发次数、上下文峰值。
12. 作为 9router 管理员，我希望用量记录真实（错误路径零 token、不伪造）。
13. 作为 9router 管理员，我希望发布可灰度、可一键回滚到 v39c。
14. 作为 9router 维护者，我希望有 CI 跑单测，且现有失败测试清零。
15. 作为多 Key 使用者，我希望我的额度与账本语义不因本次改造改变。

## 6. 用户流程

1. 客户端 `GET /v1/models?client_version=…` → 拿到 `data`（兼容）与 `models`（Codex 原生目录，含真实窗口与压缩阈值）。
2. 用户提问 → 请求进入 9router → **主动准入估算**：超阈值即回 `context_length_exceeded` → Codex 压缩后重试。
3. 通过准入 → 走既有链路（含模型/账号/额度策略）→ 上游流式返回 → 按契约下发 reasoning/文本/工具调用事件。
4. 首 token 504 → 同流内：先换账号，再按倍数延长预算（不降档）。
5. 上游排队 → 保持既有 keep-alive 原地重试；重试成功后同样允许续跑。
6. 回合结束若"宣布即停"→ 隐藏续跑 1 次（仅带 tools 的请求）。
7. 落库与可观测：usage token 准确、详情含 Codex 指标、关键路径日志可检索。

## 7. 前端改动（Dashboard）

1. 设置页新增 **Codex 适配** 分组：`autoCompactRatio`、`autoCompactMin`、`autoCompactMax`、`proactiveContextGuard`（开关）、`autoContinueMax`、`firstTokenTimeoutFallback`（枚举：`account-then-budget` / `budget-only` / `off`）、`rateLimitRetryAfterCapMs`；含默认值展示、范围校验与中文文案（`zh-CN` 词典同步）。
2. 请求详情面板新增列/区块：`reasoning 事件数`、`压缩触发次数`、`上下文峰值（估算）`、`准入拒绝原因`；沿用既有 API Key 掩码规则。
3. 模型卡片（Providers → Qoder）显示 `context_window` 与 `auto_compact_token_limit`，便于人工核对目录契约。

## 8. 后端改动

1. `src/app/api/v1/models/route.js`：新增 Codex `models[]` 目录（与 `data` 并存）。
2. `open-sse/services/qoderModels.js` / `src/lib/qoder/publicModels.js`：导出构造 ModelInfo 所需的 live 字段（窗口、`is_vl`、`is_reasoning`、`max_output_tokens`、`price_factor`）。
3. `open-sse/translator/response/openai-responses.js`：事件生命周期保真 + `encrypted_content` 产出。
4. `open-sse/translator/request/openai-responses.js`：仅最近一轮 CoT 还原为 `reasoning_content`；`compaction`/未知 item 兼容；`previous_response_id` 显式拒绝。
5. `open-sse/executors/qoder.js`：错误分类与映射；主动准入（估算与限额比对）；504 兜底策略；续跑在队列重试路径接通。
6. `open-sse/config/errorConfig.js` + `src/sse/services/auth.js`：`retry_after` 钳制与错误码透传。
7. `src/shared/services/codexCompat.js`（新增）：配置读写、默认值、校验、阈值计算 `clamp(窗口×ratio, min, max)`。
8. `src/lib/db/repos/settingsRepo.js` / `schema`: 新增配置字段（无表结构破坏，走既有 settings JSON）。
9. `.github/workflows/test.yml`（新增）：CI 跑单测。

## 9. API 设计

### 9.1 `GET /v1/models`（扩展，向后兼容）

响应体同时包含：

- `data[]`（**原样保留**，字段不变：`id/object/owned_by/name/price_factor/capabilities{vision,reasoning,contextWindow,maxOutput}`）
- `models[]`（**Codex ModelInfo**，每个模型一条，字段必须齐全）

`models[]` 单条示例（契约形状，非实现细节）：

```json
{
  "slug": "DeepSeek-Flash",
  "display_name": "DeepSeek-Flash",
  "description": null,
  "default_reasoning_level": "high",
  "supported_reasoning_levels": [
    { "effort": "low", "description": "快速" },
    { "effort": "medium", "description": "均衡" },
    { "effort": "high", "description": "深入" }
  ],
  "shell_type": "unified_exec",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 1,
  "additional_speed_tiers": [],
  "service_tiers": [],
  "default_service_tier": null,
  "available_access_programs": null,
  "availability_nux": null,
  "upgrade": null,
  "model_messages": null,
  "include_skills_usage_instructions": false,
  "include_plugin_usage_instructions": false,
  "include_apps_usage_instructions": false,
  "supports_reasoning_summary_parameter": true,
  "default_reasoning_summary": "detailed",
  "support_verbosity": false,
  "default_verbosity": null,
  "apply_patch_tool_type": null,
  "web_search_tool_type": "text",
  "truncation_policy": { "mode": "bytes", "limit": 10000 },
  "supports_image_detail_original": false,
  "context_window": 1000000,
  "max_context_window": 1000000,
  "auto_compact_token_limit": 500000,
  "effective_context_window_percent": 100,
  "experimental_supported_tools": [],
  "input_modalities": ["text", "image"],
  "supports_search_tool": false,
  "supports_experimental_context": false,
  "use_responses_lite": false,
  "node_repl_auto_review_required": false,
  "node_repl_disabled": false,
  "auto_review_model_override": null,
  "model_specialty": null,
  "tool_mode": null,
  "multi_agent_version": null,
  "multi_agent_reasoning_effort": null
}
```

规则：
- `slug` = 对外公开模型 ID（显示名），**不得**出现内部 Qoder key、账号邮箱、额度；
- 具体模型 `visibility="list"`；档位模型（`auto/ultimate/performance/efficient/lite`）`visibility="hide"`；
- `context_window` = `max_context_window` = live `max_input_tokens`；
- `auto_compact_token_limit` = `clamp(max_input_tokens × autoCompactRatio, autoCompactMin, autoCompactMax)`；
- `input_modalities` = `["text","image"]` 当且仅当 live `is_vl === true`，否则 `["text"]`；
- `data[].capabilities.vision` 与上述 `is_vl` 保持一致；
- live 目录不可用时回退静态值，但**仍必须**输出合法 ModelInfo（必填字段齐全、nullable 显式 `null`）；
- 响应时间目标 P99 < 1s（现网实测 89ms）。

### 9.2 错误体（HTTP 与流内一致语义）

```json
{ "error": { "code": "<code>", "message": "<人话>", "param": "messages" } }
```

映射表：

| 触发 | `code` | 备注 |
| --- | --- | --- |
| 本地准入拒绝 / 上游上下文溢出 | `context_length_exceeded` | 触发 Codex 自动压缩 |
| 账号额度耗尽（Key 分配额度用尽） | `insufficient_quota` | 不轮换账号 |
| 上游排队 403/10605、429 | `rate_limit_exceeded` | 带 `retry_after`（`retryAfterMs`）且钳制 ≤ `rateLimitRetryAfterCapMs` |
| 上游过载 / 504 首 token 超时（重试用尽） | `server_is_overloaded` | 可重试 |
| 请求体非法 / 非法历史 | `invalid_prompt` | 不轮换账号 |
| 其他 5xx | 保持 5xx | 可重试，不伪造 code |

流已开始的情形：以 `data:` 错误帧 + 标准 code 收尾，**不得**以助手正文 + `finish_reason=stop` 形式伪装成功。

### 9.3 `POST /v1/responses`（reasoning 契约）

事件序列（每段 reasoning 一次）：

```
event: response.output_item.added        { item: { id: "rs_<resp>_0", type: "reasoning", summary: [] } }
event: response.reasoning_summary_part.added   { item_id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } }
event: response.reasoning_summary_text.delta   { item_id, output_index, summary_index: 0, delta: "…" }   × N
event: response.reasoning_summary_text.done    { item_id, summary_index: 0, text: "<全文>" }
event: response.reasoning_summary_part.done    { item_id, summary_index: 0, part: { type: "summary_text", text: "<全文>" } }
event: response.output_item.done         { item: { id: "rs_<resp>_0", type: "reasoning", summary: [{ type: "summary_text", text: "<全文>" }], encrypted_content: "<自有不透明串>" } }
```

约束：`item_id` 全程一致且 ≤64 字符；`summary_index` 单调；`part.added` 每段仅一次；原始 CoT 只允许走 `response.reasoning_text.delta`。

## 10. 数据模型与数据库

1. `settings` 新增分区 `codexCompat`（JSON，无表结构变更）：`autoCompactRatio=0.5`、`autoCompactMin=120000`、`autoCompactMax=500000`、`proactiveContextGuard=true`、`autoContinueMax=1`、`firstTokenTimeoutFallback="account-then-budget"`、`rateLimitRetryAfterCapMs=120000`。
2. `encrypted_content` 载荷（自有可解，Codex 视为不透明）：`base64url(JSON{v:1, model, ts, coh, summaryLen})`；`coh` = CoT 文本 SHA-256 前 16 位十六进制；**不含 CoT 全文、不含任何凭据**。
3. 请求详情新增指标字段（沿用现有 JSON 记录，不新增表）：`reasoningEvents`、`compactionTriggers`、`contextPeakEstimate`、`admissionRejectReason`。
4. 不新增迁移脚本；`SCHEMA_VERSION` 不变。

## 11. 权限与安全

1. `/v1/models` 仍需 API Key 鉴权（现状满足）。
2. 目录与错误信息**不得**泄露内部 Qoder key、账号邮箱、额度、连接 ID。
3. `encrypted_content` 不得包含明文 CoT 全文或凭据，不得成为越权读取历史的通道。
4. `retry_after` 必须钳制上限（默认 120s），防止被上游数值放大成客户端长锁。
5. 主动准入为纯本地线性估算：无上游调用、无额外落库成本，不构成放大面。
6. 请求详情新增指标沿用既有脱敏规则。
7. 部署动作留痕：镜像标签、回滚容器名、灰度 Key 清单、切换时间写入 `implementation-report.md`。

## 12. 性能与可扩展性

1. `/v1/models` P99 < 1s（Codex 侧 5s 超时）；live 目录沿用 1h 缓存与并发去重。
2. 准入估算为 O(消息长度) 的本地计算，单请求 < 5ms。
3. 事件保真改造不新增上游调用次数（除既有的续跑/重试策略）。
4. 压缩频率上升带来的成本需在灰度期观测（阈值 0.5 的必然代价，通过可配项兜底）。

## 13. 错误处理

1. HTTP 与流内两路径语义一致（见 9.2）。
2. 任何可判定错误都不得伪装成功。
3. 错误路径 `requestDetails.status="error"` 且 token 记 0。
4. 上游原文完整写入容器日志（`[QODER] …` 前缀，便于 grep）。

## 14. 边界条件

| 场景 | 期望 |
| --- | --- |
| live 目录拉取失败 | 回退静态值，但 ModelInfo 仍合法 |
| 账号额度读取失败 | 保持既有 fail-open + 告警，不误判耗尽 |
| 流已开始后溢出 | in-band 标准 code；不写伪 token |
| 客户端中途断连 | 已产生 token 落库；续跑/重试停止空跑 |
| 工具调用缺 id | 生成稳定 id（既有能力），不与 reasoning id 冲突 |
| reasoning 晚于正文 | 仍保证 `output_item.added` 先于 delta |
| 多 Key 共用账号 | 额度/账本隔离语义不变 |
| 档位模型被直接调用 | 允许（不因 `hide` 而拒绝） |

## 15. 实现决策（模块与契约）

1. 新增 `src/shared/services/codexCompat.js`：唯一配置与阈值入口（读写、校验、`clamp` 计算），其他模块不得自行硬编码阈值。
2. `models` 目录构造放在 `src/app/api/v1/models/route.js`，数据来自 `decorateQoderModelsForPublic`（已含 `publicId` / `internalId` / `contextLength` / `isVL`）。
3. reasoning 产出一律走 `open-sse/translator/response/openai-responses.js` 的既有 `startReasoning/emitReasoningDelta/closeReasoning` 三函数，禁止旁路直发。
4. 请求侧只在 `openai-responses.js`（请求方向）做"最近一轮 CoT"筛选；不改变其他格式链路行为。
5. 准入估算放在 `open-sse/executors/qoder.js` 入口（上游调用前），复用 `canonicalizeUsage` 之外的保守估算工具函数（新增于 `open-sse/utils/`）。
6. 错误映射集中在 `open-sse/config/errorConfig.js` 的规则表 + `qoder.js` 的分类器，避免散落。
7. 兼容性收口：`previous_response_id` 非空即返回 `invalid_prompt`（附说明），不静默忽略。

## 16. 验收标准

1. 测试门禁通过 = **无新增失败 + 本需求新增测试全绿**（`node tests/scripts/check-baseline.mjs` 退出码 0，基线 `tests/__baseline__/known-fails.txt` 为 70 条历史遗留；见 amendments/01）。
2. `.github/workflows/test.yml` 在 push 时执行并成功。
3. `GET /v1/models` 同时含 `data`（16 条，字段不变）与 `models`（16 条，ModelInfo 必填齐全）；`DeepSeek-Flash` 的 `context_window=1000000`、`auto_compact_token_limit=500000`；`Lite` 的 `input_modalities=["text"]`，视觉模型为 `["text","image"]`。
4. 真 Codex CLI（`codex exec --json`）三场景通过，且**无** `Unknown model … fallback model metadata` 警告；reasoning item 文本非空。
5. 长上下文场景：在阈值附近触发**压缩**而非 `400`；压缩后请求成功。
6. 首 token 504 场景：先换账号、再延长预算，最终成功或按映射返回 `server_is_overloaded`。
7. "宣布即停"场景：自动续跑 1 次并产出工具调用；队列重试路径同样生效。
8. 错误路径：`requestDetails.status="error"`、token=0、无助手正文伪装。
9. 详情面板可见 reasoning 事件数/压缩触发次数/上下文峰值。
10. 生产切换后 24h 内：容器无重启、`context_length_exceeded` 导致的失败率下降、504 重试耗尽次数下降。

## 17. 测试计划

| 接缝 | 用例要点 |
| --- | --- |
| `POST /v1/responses` SSE | reasoning 事件序列与字段；文本先到；工具调用；中途断连；`item_id` 一致性 |
| `GET /v1/models` | 契约快照（必填齐全、nullable 显式 null）；`visibility`；窗口/阈值公式；`input_modalities`；无敏感信息 |
| 错误映射 | HTTP 与 in-band 两路径；5 个 code；`retry_after` 钳制；错误不落正文 |
| 主动准入 | 超阈值未打上游即回 `context_length_exceeded`；记录 error/零 token；开关关闭时行为不变 |
| `encrypted_content` | 产出形状；下一轮仅最近一轮回填；历史不注入全文；非法串降级 |
| 续跑/504/队列 | 续跑上限与触发条件；队列重试后接通；504 先换账号再延长；不降档 |
| CI | workflow 语法与执行；失败测试清零 |

**测试接缝决策**：已由用户在 Q-A 批准（7 条全采纳）。
**既有 prior art**：`tests/unit/qoder*.test.js`、`tests/unit/responses-tool-*.test.js`、`tests/unit/openai-responses-multiturn.test.js`、`tests/unit/qoder-public-models-api.test.js`、`tests/translator/bugs-codexCli-responses.test.js`、`tests/vitest.config.js` 别名。

## 18. 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| Codex App 与 CLI 渲染门控差异 | CLI 先验证；App 侧验收二次确认 | 保留 v39c 镜像 |
| 主动准入误判 | 保守估算、单回合拒绝上限、开关可关 | 关闭 `proactiveContextGuard` |
| `encrypted_content` 形状不被接受 | 形状校验 + 失败降级（不带该字段） | 关闭产出开关（配置） |
| 阈值调低致压缩变多 | 灰度观测压缩频次与 TTFT；系数可调 | 调回系数或关阈值下探 |
| `/v1/models` 共用回归 | `data` 保持原样 + 契约快照测试 | 关闭 `models` 输出（配置） |
| 生产切换失败 | 先起回滚容器、健康检查、单 Key 灰度 24h | `docker stop/rm` 新容器 → 起 v39c 容器（数据目录不动） |

## 19. 建议实现顺序

`01 → 02 → 05 → 04 → 03 → 06 → 07 → 08 → 09 → 10`
（无阻塞前沿：01、02、04、05；01/02 为 prefactor 优先落地）

## 20. 补充说明

- 本 spec 只授权 `feat/codex-agent-ux` 分支内的改动与提交；不授权 main、不授权强推、不授权对外发布动作（生产切换需单独确认）。
- `requirements.md` 为本 spec 的需求来源；第 12 节列出的延后项不在本轮范围。
- 若实现中发现契约细节与 Codex 源码不符，以 Codex 源码为准并在 `implementation-report.md` 记录偏差与依据。