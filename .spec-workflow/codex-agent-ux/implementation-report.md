# Implementation Report — codex-agent-ux@v1

## 运行期账本（Goal Mode）

| 项 | 值 |
| --- | --- |
| 授权来源 | `spec.md` §0（Goal mode: enabled for this spec only，decision date 2026-09-15） |
| 当前自动修复轮次 | 1 / 2 |
| 当前阶段 | `spec-do` ticket 01 进行中 |
| 暂停原因 | **验收标准冲突待决**：spec §16.1 要求"全绿"，但仓库存在 70 个失败用例（其中 55 个不在 `tests/__baseline__/known-fails.txt` 基线内），绝大多数与本需求无关（`cursor-agent-proto` 35、`oauth-cursor-auto-import` 8、translator normalization 4、golden 快照 4 …） |
| 下一步自动阶段 | 待用户裁定验收口径后继续 ticket 01 → 02/04/05 |

## 已完成的改动（未提交）

| 文件 | 改动 |
| --- | --- |
| `tests/unit/xai-video-handler.test.js` | 补 `buildApiKeyOptions` / `policyCredentialsResponse` mock（适配新增的 API Key 策略管道） |
| `tests/unit/gemini-native-endpoint.test.js` | 同上（hoisted mocks + `vi.mock` 工厂两侧） |
| `tests/translator/bugs-openai-bridge.test.js` | 断言改为"不得是序列化 JSON 且占位文本保持简短"（原 `/^\[/` 会误伤文档化占位符 `[Image output attached below]`） |
| `tests/unit/zh-cn-literals.test.js` | `path.resolve` → `import.meta.dirname` 相对路径（消除 CWD 依赖） |
| `tests/unit/api-key-restrictions-modal-source.test.js` | 同上 |
| `tests/package.json` | `test` 脚本去掉 Unix-only `NODE_PATH=/tmp/...`，改为 `vitest run --reporter=verbose` |
| `.github/workflows/test.yml` | 新增 CI：node 22 → 安装依赖 → `npx vitest run --config tests/vitest.config.js` |

## 验证结果

| 指标 | 改造前 | 现在 |
| --- | --- | --- |
| 失败用例 | 102 | **70**（-32） |
| 通过用例 | 1528 | 1564 |
| 受影响 3 个测试文件 | 8 failed | **27 passed / 1 expected fail** |
| 文档命令 `npm --prefix tests test` | Unix-only，失败 | 可用（跨平台） |

## 阻塞项

AC #1「全绿」与仓库既有技术债冲突，需在以下口径中择一后才能继续：
A. 把 AC 调整为"无**新增**失败 + 新测试全绿"，CI 以 `known-fails` 基线校验（推荐）；
B. 全部修绿（需另立工单，涉及 cursor proto、快照、迁移等无关模块）；
C. 冻结当前 70 为基线，CI 仅跑受影响子集（覆盖最窄）。
## 提交记录（feat/codex-agent-ux）

| Commit | 内容 | 对应票 |
| --- | --- | --- |
| `b4549d3` | 基线门禁 + 修陈旧 mock / CWD 依赖测试 + CI workflow | 01 |
| `c49346c` | requirements / spec / issues 01–11 / amendment 01 / 本报告 | to-grill + to-spec |

## 下一步（前沿）

可立即开工：**02**（Codex 适配配置骨架）、**04**（reasoning 保真与往返）、**05**（错误码映射）；**03** 待 02；**06** 待 02+05；**07** 待 03；**08** 待 05；**09** 待 03/05/06/07；**10** 收口（生产切换前必停）。
## 工单 02 进度（切片 1/3）

- 已完成：`src/shared/services/codexCompat.js`（默认值、校验、`computeAutoCompactLimit`、`getCodexCompatSettings`）+ `tests/unit/codex-compat.test.js`（5/5 通过）
- 待办：`settingsRepo` 默认段与 `settings` API 读写、Dashboard「Codex 适配」分组 + `zh-CN` 文案
- 说明：03/06/07/08 可直接 `import` 该模块，不必等 02 全部完成
## 工单 04（reasoning 保真与最近一轮往返）— 完成

- 新增 `open-sse/translator/concerns/reasoningEnvelope.js`：`base64url(JSON{v,model,ts,coh,len})`，不含 CoT 全文与凭据；`parseReasoningEncryptedContent` 对外来/损坏负载返回 null
- 响应侧：reasoning item id 稳定且 ≤64 字符、`output_index` 与 delta 一致、`summary_index` 单段、`output_item.done` 带全文 summary + 自有 `encrypted_content`
- 请求侧：`stripEarlierReasoning` 保证只有**最近一个 assistant 轮次**保留 CoT；`encrypted_content` 原样透传（对外来密文是 opaque，不做白名单丢弃）
- 测试：`tests/unit/codex-reasoning-roundtrip.test.js` 8/8；连带 `openai-responses-multiturn` 14/14；基线门禁 `70/70 → OK`
- 注意：门禁在实施中捕获过 2 个回归（多轮测试断言旧的"全量保留 CoT"行为），已按 Q5 决策更新为"仅最近一轮 + 外来 blob 透传"
## 工单 05（错误码映射）— 完成

- `open-sse/config/errorConfig.js`：新增 `CODEX_ERROR_CODES`、`clampRetryAfterMs`（上限 120s）、`resolveCodexErrorCode({status,message,fallbackCode})`、`withRetryAfterHint`
- `open-sse/utils/error.js`：`buildErrorBody(status, message, options)` 统一输出 Codex 可见 code；仅 `rate_limit_exceeded` 追加 "try again in N seconds"（Codex 用正则从 message 里解析退避时长，不读 header）
- `open-sse/executors/qoder.js`：envelope 错误走映射表；**流内错误改为真正的 error 帧**（`{"error":{code,message}}`），不再伪造 assistant 文本 + `finish_reason=stop`
- 测试：新增 `tests/unit/codex-error-mapping.test.js` 7/7；`qoder.test.js`、`qoder-context-overflow.test.js` 共 77/77（门禁捕获 3 处旧契约断言并已按 Q6 决策更新）
- 基线门禁：`70/70 → OK`
## 工单 02 切片 2/3（设置持久化与 API）— 完成

- `settingsRepo`：`DEFAULT_SETTINGS.codexCompat` 取 `CODEX_COMPAT_DEFAULTS`；**读时归一化**（历史脏值自动纠正）；`updateSettings` 对 `codexCompat` 做**深合并 + 钳制**（部分更新不会抹掉其它阈值，越界值不进库）
- `settings/route.js`：PUT 时归一化 `codexCompat`（API 侧防御）
- 测试：`tests/unit/codex-compat-settings.test.js` 3/3（临时 DB：默认值、持久化+钳制、不波及其它设置）；连带 `codex-compat` 5/5；门禁 `70/70 → OK`
- 测试过程中发现并修正两处真实缺陷：仓库层未归一化（直接调用会存越界值）、浅合并导致部分更新抹掉同级阈值
- 待办（切片 3/3）：Dashboard「Codex 适配」分组 UI + `zh-CN` 文案
## 工单 06（主动上下文准入）— 完成

- 新增 `open-sse/utils/contextAdmission.js`：CJK 感知保守估算（CJK 1.7 token/字、其它 0.4、×1.1 安全系数、含 tools+max_tokens）、`evaluateContextAdmission`（guard 关闭/无窗口/触顶保护/超限拒绝）、60s 窗口连续拒绝计数（上限 3 次后放行，避免把客户端困在拒绝循环里）
- `open-sse/executors/qoder.js`：在构建 payload 之后、发起上游之前做准入判断；拒绝时直接返回 `400 context_length_exceeded`（**0 上游调用**）
- 测试：`tests/unit/codex-proactive-guard.test.js` 4/4 —— 超限未打上游、正常放行、触顶保护、开关关闭行为不变
- 实施中发现真实缺陷：`execute()` 未解构 `modelConfig`，守卫首版会被 catch 静默跳过（已修并复测）
- 基线门禁：`70/70 → OK`
## 工单 07（auto-continue 加固）— 完成

- `continueFetch` 提升到 `execute()` 公共位置，**直连路径与队列重试路径共用**；`createQoderQueueRetryResponse` 新增 `continueFetch / hasTools / maxContinuations` 形参并在内部 `wrapQoderSSE` 转发
- 续跑次数改为读 `codexCompat.autoContinueMax`（`resolveAutoContinueMax()`：显式设置 `QODER_AUTO_CONTINUE_MAX` 时环境变量优先，便于事故期一键关闭）
- 续跑请求会剔除**空 reasoning 回合**（assistant 且内容为空且无 tool_calls），不再回放
- 测试：新增 `tests/unit/codex-auto-continue.test.js` 5/5（预算=0 不续跑、预算=1 续跑一次并产出工具调用、无 tools 不触发、**队列重试后同样续跑**、未接线时保持旧行为）；连带 `qoder-auto-continue` 11/11
- 实施记录：一次补丁把 `wrapQoderSSE(response, \`qoder/${qoderKey}\`,…)` 的模板串误伤，已在提交前发现并修复
- 基线门禁：`70/70 → OK`
## 工单 08（504 兜底 + 兼容收口）— 完成

- `resolveTimeoutPolicy(settings)`（`qoder.js` 导出）：`account-then-budget`（默认，1 次快速重试后转入延长预算，共 4 次尝试）/ `budget-only`（跳过快速重试，单次等待更长）/ `off`（保持原 env 阶梯）
- 重试循环支持 `delayFor(attempt)` 钩子；`execute()` 每请求读取 `codexCompat` 策略并同时传给直连与队列两条路径；策略名打日志
- **不降档**：策略只改等待，不改请求模型
- 兼容收口：新增 `open-sse/utils/unsupportedFeatures.js`；`chatCore` 在翻译前对非 OpenAI/Codex provider 显式拒绝 `previous_response_id`（400 `invalid_prompt`），不再静默忽略
- 测试：`tests/unit/codex-timeout-policy.test.js` 7/7（策略三态、延迟阶梯、不降档、`previous_response_id` 三种输入）
- 实施记录：政策函数重写时漏掉 `extended` 声明与残留一行 `}, extended };`，均由测试/加载即刻暴露并修复
- 基线门禁：`70/70 → OK`
## 工单 09（可观测）— 切片 1/2：日志侧完成

- 统一 `[CODEX]` 稳定前缀，便于 grep 与容器日志检索：
  - `[CODEX] admission_reject reason=… est=… limit=…`（主动准入拒绝）
  - `[CODEX] context_peak est=… limit=… window=…`（放行但已超阈值 70%）
  - `[CODEX] timeout_policy=account-then-budget|budget-only|off`（每请求一次）
  - `[CODEX] stream_done reasoning_events=N continuations=N`（流收尾，含续跑次数）
- 测试：`tests/unit/codex-observability.test.js` 1/1（断言前缀与 reasoning_events 计数）
- 门禁：`70/70 → OK`
- **待办（切片 2/2）**：把 `reasoningEvents / compactionTriggers / contextPeakEstimate / admissionRejectReason` 落进 `requestDetails` 并在请求详情面板展示；与工单 02 切片 3（Dashboard「Codex 适配」设置分组）合并为同一批前端改动
- 实施记录：一次索引定位插入误落到 keepalive 函数内（会导致每个 keepalive 都打日志），已回退并改用正向定位，验证仅 1 处、语义正确
## 工单 02 切片 3/3（Dashboard「Codex Compatibility」）— 完成 → **工单 02 关闭**

- Profile 页新增 Codex Compatibility 卡片：主动准入开关（Toggle）、压缩系数/下限/上限（Input）、续跑次数（Input）、504 策略（select：换账号后延时 / 仅延时 / 保持旧阶梯）+ 保存按钮与状态提示
- 读写走既有 `PATCH /api/settings`（已确认 PATCH 处理器内即含 `codexCompat` 归一化）；保存后用响应里的规范化值回填表单
- 验证：`npx eslint` 该页面 **0 错误**（JSX 解析通过）；`codex-compat-settings` 3/3 + `codex-compat` 5/5 + `zh-cn-literals` 1/1；基线门禁 `70/70 → OK`
- 说明：新卡片沿用 DingTalk 区的纯英文文案风格（该区域未走 i18n 词典），因此无需新增 zh-CN 键

## 工单 09 剩余（切片 2/2，仍未完成）

- 待办：把 `reasoningEvents / compactionTriggers / contextPeakEstimate / admissionRejectReason` 从执行器/翻译层落到 `requestDetails`，并在请求详情面板展示
- 现状：日志侧已可用（`[CODEX] …` 四类行），但**面板与落库还没有**，工单 09 保持开启