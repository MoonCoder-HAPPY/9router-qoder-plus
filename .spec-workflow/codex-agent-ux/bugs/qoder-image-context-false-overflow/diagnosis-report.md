# Qoder 图片上下文误判溢出故障诊断

## 故障现象

- Codex 在仍有大量真实上下文余量时显示 `Codex ran out of room in the model's context window`。
- 同一会话连续重试仍失败，新会话正常。
- 生产日志中的请求被 9router 主动准入守卫以 HTTP 400 `context_length_exceeded` 拒绝，没有发送到 Qoder。

## 红灯复现

最小复现使用一条带 3,000,000 字符 Base64 图片和短文本的请求：

```text
node --input-type=module -e "import {estimateRequestTokens,evaluateContextAdmission} from './open-sse/utils/contextAdmission.js'; const body={messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(3000000)}},{type:'text',text:'inspect this screenshot'}]}],tools:[]}; const estimatedTokens=estimateRequestTokens(body); const result=evaluateContextAdmission({estimatedTokens,contextWindow:1000000,settings:{proactiveContextGuard:true},autoCompactLimit:900000}); console.log(JSON.stringify({estimatedTokens,...result})); if(!result.allowed) process.exit(1);"
```

修复前稳定结果：退出码 1，`estimatedTokens=924062`、`allowed=false`、`limit=900000`。

执行器级回归测试修复前同样稳定得到 HTTP 400，且上游调用次数为 0。

## 生产证据

- 主动拒绝日志依次记录 `est=921552`、`est=967520`、`est=967676`，限额均为 900000。
- 前一条成功请求的路由器估算为 775702，而 Qoder 返回的实际 `prompt_tokens` 为 173562，估算高出约 4.47 倍。
- 新增截图后请求体从约 2.43 MB 增长到约 2.90/3.05 MB，估算同步跳升约 146K token。
- Codex 会话记录在失败点没有 `compaction_trigger`；失败发生在普通工具回合请求，不是远程压缩请求再次被拦截。

## 已确认根因

1. `estimateRequestTokens()` 对 multipart `message.content` 整体执行 `JSON.stringify`，将 `data:image/...;base64,...` 的传输字节按普通 ASCII 文本计算。
2. 服务端把客户端的 900K 自动压缩线同时当成硬拒绝线。客户端因真实上下文远低于 900K 不会发起压缩，但服务端的错误高估会直接返回 400。
3. 对错误返回后客户端必然自动压缩的假设不成立。该工具回合在连续三次失败中均未发送 `compaction_trigger`，普通重试无法自愈。
4. 远程压缩协议本身不是本次根因；历史会话中存在成功的 `compacted` 记录，现有 `_compact`/`compaction_trigger` 桥接测试也通过。

## 修复内容

- 按消息语义估算 multipart 内容：文本块继续按 CJK/ASCII 系数计数，图片块采用每张 8192 token 的保守视觉预算，不再按 Base64 长度计数。
- 将实际会发送给 Qoder 的 `reasoning_content` 纳入估算，避免修正图片高估后产生推理文本漏算。
- 保持 Codex 模型目录固定为 1M 窗口、900K 客户端自动压缩线。
- 将 Qoder 服务端主动守卫改为只在估算超过 1M 硬输入窗口时拒绝；900K 到 1M 的缓冲区不再被服务器抢先转成 HTTP 400。
- 修正 Codex 图片测试的 DNS mock，使 `{ all: true }` 返回标准地址数组，恢复图片链路回归覆盖。

## 回归测试

- 3 MB Base64 图片请求必须进入上游，估算小于 20K。
- 约 950K 的请求处于客户端压缩线与硬窗口之间时必须进入上游，服务端限额为 1M。
- 约 1.056M 的真实 CJK 长文本仍必须在上游调用前被拒绝。
- compact 请求仍绕过普通守卫，远程压缩响应和后续摘要恢复保持正常。

## 验证结果

```text
npx vitest run <所有文件名包含 qoder、codex 或 responses 的单元测试>
```

结果：39 个测试文件通过，238 项测试通过。

```text
npm run build
npx eslint open-sse/utils/contextAdmission.js open-sse/executors/qoder.js tests/unit/codex-proactive-guard.test.js tests/unit/codex-image-fetch.test.js
git diff --check
```

结果：生产构建通过，ESLint 通过，空白检查通过。

完整历史测试套件仍有与本次无关的既有失败：27 个测试文件、83 项测试失败，主要来自测试工作目录假设、Windows/macOS 快照差异及旧快照。运行生成的无关快照改动已清理，未纳入本次提交。

## 清理与残余风险

- 未添加临时生产 instrumentation，未保留抓包、Base64 图片或凭据。
- 每张图片采用固定保守预算；如果 Qoder 后续改变视觉 tokenizer，应使用真实 usage 样本重新校准该常量。
- 本轮未部署生产，也未执行真实账号的写入性请求；部署后应观察 `context_peak` 与 `admission_reject`，确认图片回合不再出现估算突增。
- 原始最小复现已转绿：同一请求估算为 9045，`allowed=true`。
