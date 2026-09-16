# Qoder 固定窗口与远程压缩故障诊断

## 故障现象

- 普通请求达到 900K 压缩阈值后触发 `context_length_exceeded`，但随后由 Codex 发起的 remote compact 请求也被同一个准入守卫拒绝，最终显示 `Error running remote compact task`。
- Qoder 的上下文规划会受持久化设置和实时模型目录影响，无法保证所有客户端统一使用 1,000,000 token 窗口和 900,000 token 压缩线。
- 主动拒绝次数按账号和模型共享，不同客户端会话会互相消耗拒绝次数。

## 红灯复现

修复前执行：

```text
npm --prefix tests test -- unit/qoder-remote-compaction.test.js unit/codex-proactive-guard.test.js unit/codex-compat.test.js
```

稳定结果：`3 test files failed`，`6 failed | 8 passed`。失败点准确覆盖：compact 请求被 400 拒绝、`compaction_trigger` 未识别、输出不是 `compaction` item、摘要不能在下一轮恢复、持久化设置能修改阈值或关闭守卫。

## 已确认根因

1. `QoderExecutor` 对普通推理和 remote compact 使用同一个 900K 准入守卫，compact 请求无法进入上游生成摘要。
2. Responses 请求翻译器丢弃了 `compaction_trigger` 的语义，也不会恢复上一轮 `compaction.encrypted_content`。
3. Responses 响应翻译器把 Qoder 摘要作为普通 assistant message 返回；Codex remote compaction v2 要求恰好一个 `type: "compaction"` 的 `response.output_item.done`，随后必须出现 `response.completed`。
4. Qoder 窗口策略仍读取持久化设置，且部分目录路径继续采用上游不一致的 `max_input_tokens`。
5. 主动拒绝计数缺少会话维度；无显式 `clientSessionId` 时，Qoder 后备身份又没有采用稳定的 `credentials.id`。

## 修复内容

- 新增 Qoder compaction envelope，识别 `_compact`/`compaction_trigger`，向 Qoder 发送禁用工具的纯摘要请求，并在后续请求中恢复摘要上下文。
- compact 请求绕过普通 900K 准入拒绝；响应只生成一个 `compaction` item 和 `response.completed`，不混入普通 message item。
- 所有 Qoder 模型、Codex 模型目录和 Codex 配置统一使用固定 `1M / 900K`；持久化输入不能修改该策略或关闭守卫，其余重试设置仍可配置。
- 将固定策略常量放入纯共享常量模块，避免客户端页面导入数据库服务链。
- 主动拒绝计数加入 Qoder 会话 ID，并补齐 `credentials.id` 稳定后备，保证不同会话互不影响。
- Dashboard 将固定策略控件标记为 fixed 并禁用编辑；README 同步固定策略说明。

## 协议核验

只读检查了当前 OpenAI Codex 开源实现的 `compact_remote_v2.rs` 和对应测试：remote compaction v2 通过 `/v1/responses` 流发送 `compaction_trigger`，客户端要求恰好一个 `compaction` output item，并等待 `response.completed`；`compaction.id` 为可选字段。本次实现和回归测试与该约束一致。临时源码目录已删除。

## 绿灯验证

```text
npm --prefix tests test -- unit/qoder-remote-compaction.test.js unit/codex-proactive-guard.test.js unit/codex-compat.test.js unit/codex-compat-settings.test.js unit/codex-model-catalog.test.js unit/codex-dashboard-surfaces.test.js unit/responses-abort-terminal.test.js unit/codex-reasoning-roundtrip.test.js unit/openai-responses-multiturn.test.js
```

结果：`9 test files passed`，`53 tests passed`。

扩大回归（所有文件名包含 qoder、codex 或 responses，排除下述独立既有失败）：`38 test files passed`，`231 tests passed`。

```text
npm run build
npx eslint <本次变更的 15 个 JavaScript 文件>
git diff --check
```

结果：生产构建通过，ESLint 通过，diff whitespace 检查通过。

## 独立既有失败

`tests/unit/codex-image-fetch.test.js` 单独运行仍有 2 项失败。该测试把 `node:dns/promises.lookup(..., { all: true })` mock 成单个对象，而当前实现要求记录数组，导致图片回退为原 URL。对应测试和 Codex 图片执行器均未被本轮修改，因此未混入本次压缩修复；后续应独立修复测试夹具。

## 清理

- 未添加临时调试 instrumentation。
- 协议核验的临时 Git 目录已删除。
- 没有保留临时验证、抓包、凭据或生产环境文件。
- 原始自动化复现已转绿：compact 请求不再被 900K 守卫拒绝，且 Codex 可接收并在下一轮恢复唯一 compaction item。

## 残余风险

- 已有 Codex 客户端若仍缓存旧模型目录或在本地显式覆盖窗口，需要刷新模型缓存/重新应用 9router Codex 配置后才会看到固定 `1M / 900K`。
- 本轮未连接生产服务器做真实长会话验证；部署后仍需用接近 900K 的真实会话做一次灰度确认。
