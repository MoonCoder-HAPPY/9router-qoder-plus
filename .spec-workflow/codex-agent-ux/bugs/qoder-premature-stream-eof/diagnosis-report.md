# Qoder / Codex 回复提前中断诊断报告

## 症状

在其它电脑通过 Codex 使用 9router 时，模型已经输出部分内容，但回复提前结束，客户端需要反复发送“请继续”。生产日志同时出现 `502`、`UND_ERR_SOCKET: other side closed`，但部分请求仍被客户端记录为正常完成。

## 生产证据

- 生产容器正常运行，重启次数为 `0`。
- 生产配置中的流式超时、停滞超时和网络重试均已生效。
- 生产日志确认存在真实的上游 socket 提前关闭：
  `upstream socket closed before response (UND_ERR_SOCKET: fetch failed: other side closed)`。
- 同一时间窗口内既有正常 `stream_done`，也有 `502`，但原日志缺少统一请求终止原因，难以仅靠 `POST`、`DONE` 和 `DISCONNECT` 关联请求。
- 大输入 Token 请求存在，但本次症状不是上下文窗口或压缩阈值本身导致的拒绝。

## 根因

Qoder 的 SSE 包装层在 `reader.read()` 返回 EOF 或上游连接半断时，无论上游是否发送了 `finish_reason` / `[DONE]`，都会补发 `data: [DONE]`。下游 OpenAI Responses 转换器收到 `[DONE]` 后会调用 `flushEvents()`，并无条件发送 `response.completed`。

因此，实际上只有半截内容的响应被伪装成成功完成。Codex 认为本轮已经完整结束，不会把它当成可恢复的流错误，表现为工具链中断、回复缺尾以及需要手动“请继续”。

另外，`inspectQoderResponse()` 会预读首个 SSE 数据帧以识别队列状态。若首帧已经入缓存、随后 socket 抛出 `UND_ERR_SOCKET`，这个异常此前可能在进入统一包装层前直接冒泡，形成另一条提前中断路径。

本轮复审又确认了两个此前遗漏的协议绕过：队列重试失败和自动续写失败都可能在已经建立的 SSE 响应中伪造成功收尾；此外，`/v1/responses` 的处理器在 `handleChatCore()` 已经完成 Responses 格式转换后，又套用了旧的 Chat Completions 转换器。旧转换器会忽略 `response.failed`，并在 `flush()` 无条件补发 `response.completed`，因此会把结构化失败重新伪装成成功。

## 修复内容

### 1. 明确区分流终止原因

`wrapQoderSSE()` 现在记录并暴露以下终止状态：

- `clean_done`：收到明确的 `[DONE]`。
- `finish_without_done`：已收到有效 `finish_reason`，但上游缺少可选的 `[DONE]`。
- `premature_eof`：连接正常 EOF，但没有任何终止 `finish_reason`。
- `upstream_error`：收到结构化错误帧或底层读取异常。

无 `finish_reason` 的 EOF 不再补发成功结束，而是发送 OpenAI 兼容错误帧：

```json
{"error":{"type":"server_error","code":"stream_disconnected"}}
```

这会经过已有 Responses 转换器生成 `response.failed`，并保留 `[DONE]` 作为 SSE 传输收尾，避免生成 `response.completed`。

### 2. 修复预读层的半断连接

队列状态预读现在会：

- 回放已经缓存的首帧，再让统一包装层处理后续 socket 错误。
- 尚未收到任何数据就断开时，构造结构化 `stream_disconnected` SSE 响应。

### 3. 修复 Claude 兼容路径

OpenAI→Claude 响应转换器现在识别结构化 `chunk.error`，输出 Claude `error` 事件，不会把错误流静默收尾为成功消息。

### 4. 增加终止原因观测

Qoder `stream_done` 日志增加 `termination=<reason>`，共享 Codex 请求指标增加 `streamTermination`，便于后续从生产日志区分正常完成、无 `[DONE]` 完成、提前 EOF 和上游错误。

### 5. 收紧所有失败收尾路径

- 队列等待、队列重试、首 Token 超时预算耗尽和重试请求 socket 失败统一输出结构化错误帧，不再输出带 `finish_reason: "stop"` 的助手文本。
- 自动续写请求抛错或返回空流时输出 `stream_disconnected`，不再仅发送 `[DONE]`。
- 已收到 `finish_reason` 后只有正常 EOF 才能走 `finish_without_done` 兼容路径；`reader.read()` 抛出的 socket、网络或其它异常仍按失败处理，`AbortError` 保持客户端中止语义。
- `/v1/responses` 流式响应直接透传 `handleChatCore()` 生成的最终 Responses SSE，避免二次转换丢失错误事件或伪造完成事件。

## 红色复现与验证

新增并先确认失败的回归场景：

1. Qoder 输出一个普通内容 chunk，没有 `finish_reason`，随后 EOF。
2. Qoder 输出一个普通内容 chunk，随后底层抛出 `UND_ERR_SOCKET`。
3. 两个场景均通过真实 Qoder executor 路径和 Responses 转换路径验证，要求输出 `response.failed` / `stream_disconnected`，且禁止 `response.completed`。

原始红色结果：上一轮的直接 EOF、socket close、队列失败和自动续写失败均分别复现过成功收尾问题；本轮新增的两个复现为“finish_reason 后 socket close”以及“Responses handler 二次转换导致 response.failed 被替换为 response.completed”。

## 验证结果

本轮直接相关定向回归通过：

```text
npx vitest run --config tests/vitest.config.js --pool=threads --maxWorkers=1 tests/unit/qoder-finish-transport-error.test.js tests/unit/responses-handler-stream.test.js tests/unit/qoder-socket-retry.test.js tests/unit/qoder-queue-stream.test.js tests/unit/qoder-first-token-timeout.test.js tests/unit/codex-auto-continue.test.js tests/unit/codex-observability.test.js tests/unit/qoder.test.js tests/unit/openai-to-claude-response-tools.test.js tests/unit/openai-responses-terminal-event.test.js tests/unit/responses-abort-terminal.test.js tests/unit/qoder-remote-compaction.test.js
12 test files passed
108 tests passed

node --check open-sse/executors/qoder.js
node --check open-sse/translator/response/openai-to-claude.js

npm run build
Next.js production build passed
TypeScript passed
131 static pages generated
```

完成第二轮状态机复审后，重新运行的核心回归为：

```text
10 test files passed
62 tests passed
```

新增回归覆盖内部 stall watchdog 以普通 `Error("stream stall timeout")` abort、底层 reader 以 `AbortError` 拒绝的组合，确认该路径仍输出 `stream_disconnected` 和 `[DONE]`，不会被当成客户端主动取消而静默结束。

同时通过：

```text
npx eslint <本次修改的运行时代码和回归测试文件>
node --check open-sse/executors/qoder.js
node --check open-sse/handlers/responsesHandler.js
node --check open-sse/translator/response/openai-to-claude.js
git diff --check <本次修改文件>
```

## 已修改文件

- `open-sse/executors/qoder.js`
- `open-sse/handlers/responsesHandler.js`
- `open-sse/translator/response/openai-to-claude.js`
- `open-sse/utils/stream.js`
- `open-sse/utils/streamHandler.js`
- `tests/unit/qoder-finish-transport-error.test.js`
- `tests/unit/responses-handler-stream.test.js`
- `tests/unit/stream-terminal-framing.test.js`
- `tests/unit/qoder-socket-retry.test.js`
- `tests/unit/qoder.test.js`
- `tests/unit/codex-observability.test.js`
- `tests/unit/openai-to-claude-response-tools.test.js`

## 已知测试基线

仓库现有 `tests/unit/openai-to-claude.test.js` 中的一个旧测试在本轮单独运行时失败：测试要求未带 `finish_reason` 的工具参数立即输出 `input_json_delta`，而当前实现会缓冲工具参数并在 `finish_reason` 时统一清洗输出。该失败在本修复前已存在，且不涉及本次修改文件中的行为目标；本轮未扩大范围修改该既有语义。

完整仓库 Vitest 还受到当前 Windows 工作站环境与既有测试基线影响，出现了数据库并发、外部网络/服务、平台路径、动态 provider 快照以及若干已有 translator 测试失败。完整套件未作为本次修复的通过标准；与本次改动直接相关的定向套件已单独重复验证并全部通过。

## 清理与剩余风险

## 子代理复审结论

第二轮深度复审先后确认了“finish_reason 后传输异常”和“Responses 二次转换”两个真实缺口；修复后，相关子代理验证的终止状态机和协议输出与本地 12 个定向测试文件、108 项测试结果一致，未发现新的 P1/P2 失败收尾路径。结论：**本地修复通过 review，可以进入提交/部署审批；本轮没有执行提交、推送或生产部署。**

随后基于最新工作树又补跑了 Qoder 终止、队列/网络重试、自动续写、Responses/Claude framing 和 watchdog 场景。已完成的独立复核未发现新的 P1/P2 失败收尾路径；两条跨格式子代理在要求收束时仍处于运行中，未产生新的阻塞结论，因此不把它们的未完成状态当作通过证据。最终通过依据是可重复的 10 文件/62 测试回归、构建、Lint、语法和 diff 检查。

- 未添加临时生产日志或生产环境 instrumentation。
- 未发现 `[DEBUG-...]` 临时调试日志。
- 完整仓库测试未作为通过标准：从 `tests` 子目录启动时存在既有路径假设，且当前环境缺少 `lowdb`、`cloud` 目录和部分外部服务；另有与本次无关的快照、平台路径、数据库并发和 translator 基线失败。它们没有出现在本次直接相关测试文件中。
- 未提交、未推送、未部署生产；生产环境仍需用户明确授权后执行发布和回滚验证。
- 现有日志仍没有贯穿整个请求生命周期的统一 request ID，这是后续生产诊断的架构改进建议，但不影响本次终止语义修复。
- 当前修复把所有已确认的异常终止显式报告为结构化失败，客户端是否自动重试取决于 Codex 对 `response.failed` / `stream_disconnected` 的处理；本地已验证不会再被伪装为 `response.completed`。

## 最新复审与最终验证（2026-09-22）

本轮针对最新工作树重新执行了三条只读子代理复审轴：Qoder executor 终止状态机、跨格式 Responses/Claude 终止协议、测试覆盖与假阳性检查。子代理任务均完成；最终是否通过以本地可复现验证和主审计结果为准。

主审计额外发现并修复了一个防御性缺口：`open-sse/utils/stream.js` 的 `flush()` 原先会吞掉转换异常，让异常流有机会以正常 EOF 结束。现在会以 `completed:false` 记录 partial usage，并重新抛出，使 `streamHandler` 进入统一错误终止路径；新增 `tests/unit/stream-flush-failure.test.js` 覆盖该契约。

最新验证结果：

```text
3 个新增/相关 framing 与 callback 测试文件：8 passed
43 个相关测试文件：43 passed，1 skipped
测试断言：277 passed，4 skipped
ESLint：通过（本轮运行时代码与相关测试文件）
node --check：通过（6 个运行时代码 + 新增测试）
git diff --check：通过
npm run build：通过，TypeScript 通过，131 个静态页面生成
```

审计结论：当前已确认的 Qoder EOF、`UND_ERR_SOCKET`、底层 `AbortError`、finish 后传输异常、队列/504 重试耗尽、自动续写失败、Responses 缺失终端事件、重复 `[DONE]` 和 flush 转换异常，均不会再走成功回调或伪造 `response.completed`。正常 `finish_reason` + 正常 EOF/`[DONE]` 仍保留成功路径。

生产仍未提交、推送或部署；真实 Codex 客户端跨网络长连接验证仍属于部署后的验收项。工作树中的其它既有 snapshot、工作流文件和测试改动未回滚。

## 继续复审与最新修复（2026-09-22）

后续深度复审又构造出三个此前没有被实际生产包装路径覆盖的时序缺口，并已修复：

1. `TransformStream.flush()` 对没有结尾空行的 `event: ...` + `data: ...` Responses 尾帧丢失事件名，导致合法 `response.completed` 被误合成为 `response.failed`。
2. `pipeWithDisconnect()` 重新包装转换流时丢失 `hasTerminal` / `flushPartialUsage` 生命周期接口；实际生产路径在已完成后遇到迟到 socket 错误时会追加失败帧，且无法正确记录完成状态。
3. 已完成终态后的迟到错误仍可能污染错误日志或留下 `PENDING` request log；现在最终 request log 与完成/失败状态在 `recordCompletion()` 中统一收口，已终态后的迟到错误被忽略，真正半截流仍记录 `FAILED 502`。

新增回归覆盖：

- Responses 尾帧无空行；
- 原生 passthrough 与普通 Responses 翻译两条真实 `pipeWithDisconnect()` 路径；
- `UND_ERR_SOCKET` 和未知迟到异常；
- 已完成终态仍触发成功完成记录，半截流仍触发失败记录。

最新验证：

```text
49 个相关测试文件：48 passed，1 skipped
测试断言：309 passed，4 skipped
node --check：17 个文件通过
ESLint：通过
git diff --check：通过
npm run build：通过，TypeScript 通过，131 个静态页面生成
```

当前仍未提交、push 或部署。代码级终止状态、终态竞态、Qoder 重试/隔离和日志收口已完成本地审查；部署后仍需使用真实 Codex 客户端进行跨网络长连接验收。
