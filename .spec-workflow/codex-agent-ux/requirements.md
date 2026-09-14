# Codex Agent 体验改造 — 需求研究结论（to-grill）

## 0. 元信息

| 项 | 值 |
| --- | --- |
| 需求标题 | 提升 ChatGPT Codex 用户经 9router（Qoder 后端）的 agent 体验 |
| 需求 slug | `codex-agent-ux` |
| Git 入口 | 仓库 `MoonCoder-HAPPY/9router-qoder-plus`；本地根 `C:\Users\jingdan\Desktop\9router\repo`；分支 `feat/codex-agent-ux`（自 `main@bbd6daa` 切出）；写此文时 worktree 干净（0 改动 / 0 未跟踪） |
| 回滚基线 | `main@bbd6daa` == 线上镜像 `9router:qoder-plus-context-error-v39c`（逐字节一致，LF 归一化 SHA256 校验通过） |
| 生产环境 | `175.178.223.16`，容器 `9router`，端口 `20128`，数据目录 `/home/ubuntu/.9router -> /app/data`，`REQUIRE_API_KEY=true` |
| 调研证据 | ① openai/codex 源码（本地克隆，7824 文件）② 线上容器内 SSE 探针（`/v1/chat/completions`、`/v1/responses`）③ 线上 SQLite（requestDetails/apiKeys/usageHistory）④ 容器日志 12951 行 ⑤ `/v1/models` 实测 89ms / 16 模型 / 仅 `data` |

## 1. 背景

9router 把 Qoder（DeepSeek-Flash 等）模型以 OpenAI/Responses 兼容形式提供给 Codex 客户端（App 与 CLI）。用户反馈两个体感问题：

1. **思考过程没有展开**：Codex UI 不显示/不展开 thinking。
2. **上下文适配有问题**：长会话体验差、会撞上下文与超时错误。

源码级调研结论：

- 我方向 Codex 发送的 reasoning 事件序列**本身合规**（`output_item.added(reasoning)` → `reasoning_summary_part.added` → `reasoning_summary_text.delta` × N → `..._text.done` / `..._part.done` / `output_item.done`），Qoder 上游也确实返回 `reasoning_content`（实测单轮 ~291 chunk）。
- 真正的短板有三处：**(a)** Codex 对 `DeepSeek-Flash` 等 slug 使用兜底模型元数据（`context_window=272000`、`effective_context_window_percent=95`、`supported_reasoning_levels=[]`、`auto_compact_token_limit=None`），因为我们的 `/v1/models` 只返回 `{"data":[…]}`，而 Codex 只解析 `{"models":[…ModelInfo…]}`；**(b)** 缺失 `encrypted_content`，跨轮推理连续性只能靠 summary 文本回填；**(c)** 错误码未按 Codex 语义映射，且压缩时机由 Codex 的低估 tokenizer 决定，导致线上出现真实 318k 输入、4 次 >1M 上下文溢出 400、10 次 504 重试耗尽。

用户已明确要求：**改造方案中列出的问题全部落实（P0+P1+P2），不允许只做其中一条**。

## 2. 目标

在**不改动 Codex 客户端**的前提下，通过服务端协议保真与元数据修正，使 Codex 用户获得：

1. 思考过程可见（reasoning 事件与元数据双通道正确）；
2. 上下文行为可预期（准确窗口 + 提前无损压缩，杜绝"打到天花板才 400"）；
3. 失败可恢复（错误码让 Codex 自己压缩/退避，而不是把错误当正文写进历史）；
4. 长会话连续性（最近一轮 CoT 往返、队列重试后仍能续跑、首 token 超时有兜底）；
5. 可观测与可回滚（请求详情可见 Codex 指标；灰度发布；保留回滚镜像）。

## 3. 非目标

- 不合并上游 0.5.75（235 个文件差异）—— 另立需求。
- 不修改 Codex 客户端、不 fork Codex。
- 不改动 Dashboard 信息架构（仅新增 Codex 指标展示与相关设置项）。
- 不实现 OpenAI/Azure 专用的 `/v1/responses/compact` 远程压缩协议（非 OpenAI provider 在 Codex 侧走本地压缩，与 Codex 行为一致）。
- 不在本轮处理：钉钉 Webhook SSRF 加固、Gemini/Antigravity OAuth 环境变量文档化、镜像内 macOS `._*` 垃圾清理与镜像瘦身（见第 12 节）。

## 4. 用户流程

**主流程（Codex App/CLI → 9router → Qoder）**

1. 客户端拉取模型目录：`GET /v1/models?client_version=…`（5s 超时）→ 取得 Codex 原生 `models` 目录 → 采用真实 `context_window` 与 `auto_compact_token_limit`。
2. 用户提问（可能带 tools / 图片）→ 请求进入 9router → **准入估算**（S5）：若估算超阈值，直接回 `context_length_exceeded`，客户端压缩后重试。
3. 正常请求 → 上游流式返回 → 我方按事件契约下发 reasoning/文本/工具调用 → UI 实时展示思考与输出。
4. 出现首 token 504 → 同流内换账号/延长预算重试（S7）；出现排队 → 保持 keep-alive 原地重试（既有能力）。
5. 回合结束若"宣布即停"（有 tools 但无 tool_call）→ 隐藏续跑 1 次（S6）。
6. 用量与指标落库 → 请求详情可见（S9）。

## 5. 功能范围

**S1 模型目录契约（P0）**：`/v1/models` 同时返回 `data`（原样，向后兼容）与 `models`（Codex ModelInfo 契约，16 个模型）；具体模型 `visibility="list"`，档位模型 `auto/ultimate/performance/efficient/lite` 为 `"hide"`；`slug` = 对外公开模型 ID（显示名），内部 Qoder key 不外泄；同时修正 `data[].capabilities.vision` 为 live `is_vl` 的真实值。

**S2 reasoning 往返策略（P0）**：`summary` 承载真实 CoT（UI 可见、可展开）；`encrypted_content` 为自有可解不透明串（含 model、时间戳、CoT 哈希，**不含全文**）；构建上游请求时**仅最近一轮 assistant 的 CoT** 还原为 `reasoning_content`，历史 reasoning 不注入全文。

**S3 reasoning 事件生命周期保真（P1）**：`part.added` 每段仅一次；`summary_index` 单调；`item_id` 在 added/delta/done 全程一致且 ≤64 字符；`done` 携带全文；原始 CoT 仅走 `reasoning_text.delta`（默认不渲染路径），不得与 summary 通道混用。

**S4 错误码映射（P0）**：上下文类 → `context_length_exceeded`；额度耗尽 → `insufficient_quota`；排队/限流（403/10605、429）→ `rate_limit_exceeded` 且带 `retry_after`；上游过载/504 → `server_is_overloaded`；请求体非法 → `invalid_prompt`；其余 5xx 保持 5xx。HTTP 与流内（已开始下发）两条路径都要遵守；HTTP 错误体统一 `{"error":{"code","message"}}`。

**S5 主动上下文准入（P0）**：请求进入上游前按保守本地估算与该模型的 `auto_compact_token_limit` 比对，超阈值即回 `context_length_exceeded`（附估算值与限额），默认开启、设置页可关；同一回合连续主动拒绝需有上限保护。

**S6 auto-continue 加固（P1）**：默认上限 1 次、仅当请求带 tools 且无 tool_call 且 finish=stop 且判定为"宣布即停"时触发；**队列重试成功路径也要接上续跑**；续跑请求剔除空 reasoning 回合。

**S7 首 token 504 兜底（P1）**：先换账号，再延长预算；**不静默降档**（降档会隐性降质）；次数与预算可配。

**S8 兼容性收口（P1）**：不支持 `previous_response_id` 时显式报错而非静默忽略；item id 稳定化；空 reasoning 回合不污染历史。

**S9 可观测（P2）**：usage 输入/输出 token 准确落库；请求详情展示 reasoning 事件数、压缩触发次数、上下文峰值；关键路径日志（准入拒绝、压缩触发、续跑、504 兜底）可检索。

**S10 护栏与交付（P2）**：新增单测（reasoning 事件序列、ModelInfo 契约快照、错误映射、主动准入、`encrypted_content` 往返）；**修复现有 19 个失败测试**；新增 CI 工作流跑单测；镜像构建保留回滚容器，按 API Key 灰度。

**S11 验收（P2）**：用真 Codex CLI（`codex exec --json`）跑三场景（纯问答 / 带工具链 / 长上下文），断言：reasoning item 非空且无 `Unknown model … fallback model metadata` 警告；长上下文触发压缩而非 400；不再出现"宣布即停"。

## 6. 业务规则

1. **元数据真实性**：窗口取 live `max_input_tokens`，不虚报、不缩水；压缩阈值必须低于窗口（本轮口径 `clamp(真实值 × 0.5, 120k, 500k)`）。
2. **不为省事伪装能力**：`input_modalities` 严格按 `is_vl`；非视觉模型收图仍本地 400。
3. **不伪造用量**：主动拒绝、压缩触发、错误路径一律 `status=error`、零 token，不产生假记录。
4. **绝不把错误当正文**：任何可判定为错误的上游结果，都不得以助手文本 + `finish_reason=stop` 下发（流已开始的情形除外，且需带标准错误码语义）。
5. **压缩不是降质**：压缩由客户端执行，服务端只负责"如实报告 + 提前预警"，不替客户端改写用户历史。
6. **额度语义不变**：S2/S5 不得影响既有 credit 计费与 Key 分配口径。
7. **可回滚**：任何变更必须能以镜像级回滚回到 v39c。

## 7. 数据语义

**7.1 `/v1/models` 的 `models[]`（Codex ModelInfo）关键字段映射**

| 字段 | 取值来源 |
| --- | --- |
| `slug` / `display_name` | 公开模型 ID（显示名，如 `DeepSeek-Flash`） |
| `context_window` / `max_context_window` | live `max_input_tokens`（如 1000000 / 180000） |
| `auto_compact_token_limit` | `clamp(max_input_tokens × 0.5, 120000, 500000)`，系数与上下限可配 |
| `effective_context_window_percent` | 保持 100（预留由阈值承担，避免双重打折） |
| `supported_reasoning_levels` / `default_reasoning_level` | 我方档位阶梯（low/medium/high；默认对齐客户端设置） |
| `supports_reasoning_summary_parameter` / `default_reasoning_summary` | `true` / `detailed` |
| `input_modalities` | `["text"]` 或 `["text","image"]`（按 `is_vl`） |
| `truncation_policy` | 与现状一致的工具输出截断口径 |
| `visibility` | 具体模型 `list`，档位模型 `hide` |
| 其余必填字段 | 显式给出（nullable 字段允许 `null`，但必须出现，否则整包解析失败） |

**7.2 `encrypted_content`**：base64(自有 JSON) = `{v, model, ts, coh(CoT 哈希), summaryLen}`；不含 CoT 全文、不含凭据。仅用于 Codex 原样回传；服务端解回后用于校验与流水，不替代 `summary`。

**7.3 设置项（新增，均可配且持久化）**：`autoCompactRatio=0.5`、`autoCompactMin=120000`、`autoCompactMax=500000`、`proactiveContextGuard=on`、`autoContinueMax=1`、`firstTokenTimeoutFallback=account-then-budget`。

## 8. 权限、安全与审计

1. `/v1/models` 仍需 API Key 鉴权（现状满足，实测未鉴权返回 401）。
2. Codex 目录**不得**泄露 Qoder 内部 key、账号邮箱、额度或其他连接标识；只暴露公开模型 ID 与能力。
3. `encrypted_content` 不含明文 CoT 全文与任何凭据；不得成为越权读取历史的通道。
4. `retry_after` 必须钳制上限（建议 ≤120s），避免被上游数值放大成客户端长时锁死。
5. 主动准入拒绝不得成为放大攻击面（估算为线性、无上游调用、无额外落库成本）。
6. 请求详情新增指标沿用既有脱敏规则（API Key 掩码）。
7. 部署动作留痕：构建镜像标签、回滚容器名、灰度 Key 清单、切换时间点记录在实现报告中。

## 9. 异常与边界场景

| 场景 | 期望行为 |
| --- | --- |
| live 模型目录拉取失败 | 回退静态默认值，但**仍必须**输出合法 ModelInfo（否则 Codex 退回兜底元数据） |
| 账号额度读取失败 | 保持既有 fail-open（不误判耗尽、不切换），并发告警 |
| 流已开始后才发生上下文溢出 | in-band 错误 + 标准 code；不写伪 token；记录可诊断原文 |
| 客户端中途断连 | 已产生 token 落库（既有能力），续跑/重试不得继续空跑 |
| 工具调用缺 id | 生成稳定 id（既有能力），且与 reasoning item id 不冲突 |
| reasoning 晚于正文到达 | 事件顺序仍合法（不得在文本 item 之后补发 reasoning delta 造成 added 缺失） |
| 并发多会话/多 Key 共用账号 | 额度与账本隔离语义不变 |
| 模型目录超时 | 我方 P99 目标 < 1s（实测 89ms），避免触发客户端 5s 超时 |

## 10. 风险

1. **Codex 客户端版本差异**：App 的 thinking 渲染门控与 CLI 不同；本轮以 CLI 兜底验证，App 侧需在验收时二次确认。
2. **主动准入误判**：本地估算偏差过大可能导致"该压不压"或"过早压缩"；用保守估算 + 单回合拒绝上限缓解。
3. **`encrypted_content` 格式风险**：格式不被 Codex 接受会导致 item 解析失败；实现需按契约做形状校验与降级（失败时退化为不带该字段）。
4. **阈值调低带来更多压缩**：压缩=一次全上下文摘要，成本与延迟上升；灰度期观测压缩频次与 TTFT。
5. **触碰生产链路**：部署失败或数据目录受损；用回滚容器 + 数据目录只读校验 + 切换前健康检查缓解。
6. **回归面**：`/v1/models` 与 translator 被多客户端共用；以 `data` 保持向后兼容 + 全量单测回归缓解。

## 11. 已闭合问题（Q1–Q13）

| # | 问题 | 决定 |
| --- | --- | --- |
| Q1 | 分支策略 | 新建 `feat/codex-agent-ux`（自 `main@bbd6daa`），main 保持=v39c |
| Q2 | 落地与部署链路 | 全链路由 AI 执行：本地改 → push 分支 → 服务器构建 → 回滚容器 → 验收 → 切生产 |
| Q3 | `/v1/models` 契约 | `data` + `models` 并存；16 模型全给；具体 `list`、档位 `hide`；修正 `vision` |
| Q4 | 窗口与压缩阈值 | 真实窗口 + `clamp(真实 × 0.5, 120k, 500k)`，可配 |
| Q5 | reasoning 往返 | 最近一轮 CoT 生效 + summary 可见 + 自有可解 `encrypted_content`；历史不注入全文 |
| Q6 | 错误码与主动触发 | 全量映射；主动压缩触发默认开、可关 |
| Q7 | auto-continue 边界 | 默认 1 次、仅带 tools、队列重试路径接续跑 |
| Q8 | 504 兜底 | 先换账号、再延长预算；不降档；可配 |
| Q9 | 验收口径 | 真 Codex CLI 三场景 + 事件级断言；单测进 CI，端到端手动 |
| Q10 | 回滚/灰度 | 保留 v39c 镜像；先单 Key 灰度 24h |
| Q11 | 是否跟随上游 0.5.75 | 本轮不做，另立需求 |
| Q12 | 失败测试与 CI | 修复现有 19 个失败测试并新增 CI 测试工作流 |
| Q13 | Codex 客户端版本 | 用服务器上的 Codex CLI（GitHub 实测可达）先行验证；App 版本在验收阶段由用户确认 |

## 12. 显式延后 / 超出范围

- 上游 0.5.75 合并（235 文件、SAML、更多 provider）→ 另立需求。
- 钉钉 Webhook SSRF 加固（`/api/settings/model-idle-alert/test` 触发面）→ 另立安全需求。
- Gemini / Antigravity OAuth 凭据环境变量未文档化 → 另立文档需求。
- 镜像瘦身（2154 个 `._*` 垃圾文件）、构建缓存与旧镜像清理 → 运维清理项。
- 服务器侧 20128 端口暴露治理（安全组/反代）→ 运维项。
- Dashboard 状态页/告警的进一步产品化 → 后续需求。

## 13. 建议下一步

进入 `to-spec`：以本文件为唯一输入，产出实现级 spec（文件级改动清单、事件契约示例、错误映射表、配置项与默认值、测试矩阵、灰度与回滚步骤、验收脚本）。