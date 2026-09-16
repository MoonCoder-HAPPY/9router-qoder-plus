# Codex 思考过程无法展开故障诊断

## 故障现象

Qoder 返回了完整 reasoning 文本，但 Codex 客户端始终把思考过程显示成一行，无法形成带正文的可展开 reasoning 区块。

## 红灯复现

```text
npm --prefix tests test -- unit/codex-reasoning-roundtrip.test.js
```

修复前稳定结果：`1 test file failed`，`2 failed | 6 passed`。失败断言直接证明 Responses 流只产生 `summary_index: 0`，最终 reasoning item 也只有一个 summary part。

## 已确认根因

`openaiToOpenAIResponsesResponse` 把全部 reasoning 增量放入唯一的 `summary_index: 0`。Codex 客户端把 `response.reasoning_summary_part.added` 作为 reasoning 区段边界：状态标题和可展开正文必须是不同 part。单 part 结构只能形成一行状态摘要，不能形成正文区块。

模型目录已经返回 `supports_reasoning_summary_parameter: true` 和 `default_reasoning_summary: "detailed"`，因此不是客户端配置降级。完整 SSE 管线也没有丢失事件，问题发生在响应翻译器生成事件时。

## 修复内容

- `summary_index: 0` 发送并完成固定状态标题 `**Reasoning**`。
- `summary_index: 1` 持续发送完整 reasoning 正文。
- `response.output_item.done` 保留标题和正文两个 summary part，确保流式阶段与最终 item 一致。
- Responses 请求回译时剥离路由生成的固定标题，避免下一轮把该标题作为模型 reasoning 内容发送给 Qoder。
- 新增完整 SSE 管线回归，验证 part added、正文 delta、最终 completed 事件均保持正确结构。

## 验证

聚焦回归：`1 test file passed`，`9 tests passed`。

相关回归：

```text
npm --prefix tests test -- unit/codex-reasoning-roundtrip.test.js unit/openai-responses-multiturn.test.js unit/qoder-remote-compaction.test.js unit/openai-responses-terminal-event.test.js unit/responses-abort-terminal.test.js unit/codex-observability.test.js unit/responses-tool-order.test.js unit/responses-tool-call-id.test.js
```

结果：`8 test files passed`，`37 tests passed`。

扩大回归（所有文件名包含 qoder、codex 或 responses，排除已有独立图片夹具失败）：`38 test files passed`，`232 tests passed`。

```text
npm run build
npx eslint open-sse/translator/concerns/reasoning.js open-sse/translator/request/openai-responses.js open-sse/translator/response/openai-responses.js tests/unit/codex-reasoning-roundtrip.test.js
git diff --check
```

结果：生产构建、ESLint 和 whitespace 检查全部通过。

## 清理与残余风险

- 未添加临时调试 instrumentation。
- Codex 协议核验使用的临时源码目录已删除。
- 没有保留抓包、凭据或生产环境文件。
- 自动化原始复现已消失；本轮未在生产客户端做视觉确认，部署后需要新建会话验证展开效果。已有会话中已经落盘的旧单 part reasoning 不会被追溯改写。
