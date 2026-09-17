# Qoder 首 Token 前 socket 断连诊断报告

## 症状

生产 `/v1/responses` 间歇返回：

```text
[qoder/dfmodel] [502]: fetch failed
(cause: UND_ERR_SOCKET: other side closed)
```

失败全部发生在首 Token 前，`ttft=0`，无 token usage，随后同一请求的客户端重试会继续轮换并锁定账号，最终出现 `all accounts locked for dfmodel`。

## 生产证据

- 最近 1000 条请求详情中：967 成功、33 失败；33 次失败全部为 `qoder/dfmodel` 和 `UND_ERR_SOCKET: other side closed`。
- 失败耗时集中在约 88 秒附近，但不是固定硬阈值；线上仍有 45 次成功请求的 TTFT 超过 80 秒、12 次超过 90 秒。
- 多个 Qoder 账号均有成功和失败记录，因此不是单账号凭证失效。
- 失败后账号被默认 30 秒 transient 规则写入 `modelLock_dfmodel`，客户端并发重试会逐个锁完整个账号池；锁过期后同一账号可立即恢复成功。

## 最小复现

命令：

```powershell
npm --prefix tests test -- --config vitest.config.js unit/qoder-socket-retry.test.js
```

修复前的确定性结果：5 项中 3 项失败。

- 第一次 `proxyAwareFetch` 抛 `UND_ERR_SOCKET` 后执行器直接抛错，没有内部重试。
- 重试耗尽场景只调用上游一次。
- `checkFallbackError(502, "UND_ERR_SOCKET: other side closed")` 返回 `shouldFallback=true, cooldownMs=30000`。

该测试直接驱动 `QoderExecutor.execute()`，mock 的网络层第一次抛出与生产一致的嵌套 undici socket 异常。

## 排查假设与结论

1. **已确认：Qoder 自定义执行器绕过 BaseExecutor 网络重试。** `QoderExecutor.execute()` 自行调用 `proxyAwareFetch()`，fetch 异常直接越过已有 502 retry 配置。
2. **已确认：现有 504/队列恢复只处理已经取得的 Response。** `UND_ERR_SOCKET` 在响应头之前抛出，因此 `inspectQoderResponse()` 和 `createQoderQueueRetryResponse()` 无法接收。
3. **已确认：未知 502 默认被当作账号故障。** `checkFallbackError()` 未匹配 socket 错误时使用 30 秒 transient cooldown，导致账号池雪崩。
4. **已排除：客户端主动取消。** `AbortError` 由单独测试确认不会进入 socket 重试。

## 根因

上游或中间链路在首 Token 前关闭 TCP 连接只是请求级传输故障，但 Qoder 自定义执行器没有处理 fetch-before-response 异常。异常被 `chatCore` 统一映射为 502，账号 fallback 又把未知 502 误判为账号故障并写入模型锁。单次链路抖动因此被放大为账号池整体不可用。

## 修复

- 只识别明确的 `UND_ERR_SOCKET`、`ECONNRESET`、`EPIPE`、`other side closed`、`socket hang up`、`connection reset`。
- 首 Token 前命中上述错误时，在同一账号内部仅重试一次。
- 重试前重新生成 `request_id`、`request_set_id`、`chat_record_id`、business id，并重建编码请求体和 COSY 签名。
- 重试阶段立即返回 SSE keepalive，避免客户端在内部恢复期间再次提交请求。
- 重试后若进入既有 504/排队状态，继续交给原有 timeout/queue retry ladder。
- 重试耗尽时发送 `server_is_overloaded` 错误帧；Responses API 会转换为 `response.failed`，不会生成正常助手回复或污染历史。
- 明确的传输断连加入 `noFallback` 规则，不写入账号模型锁；普通 502、401/403/429 的既有 fallback 行为保持不变。
- 不增加 80 秒主动超时。生产存在超过 80 秒后成功的请求，硬超时会制造新的误杀。

## 回归覆盖

测试文件：`tests/unit/qoder-socket-retry.test.js`

- 一次 socket 断连后重试成功。
- 每次重试刷新请求身份和签名请求体。
- 只允许一次内部 socket 重试。
- 重试耗尽输出 `server_is_overloaded` 和 `[DONE]`。
- `/v1/responses` 转换结果为 `response.failed`，不出现 `response.completed`。
- socket 后的 504 继续进入原有 timeout ladder。
- 客户端 `AbortError` 不重试。
- 普通 HTTP 401 和无关 502 的 fallback 行为不变。
- 所有明确传输错误均不进入账号锁定路径。

## 验证与清理

相关 Qoder/Codex 回归：

```powershell
npx vitest run --config tests/vitest.config.js --reporter=dot tests/unit/qoder tests/unit/codex-error-mapping.test.js tests/unit/codex-504-retry-ladder.test.js tests/unit/codex-timeout-policy.test.js
```

结果：19 个测试文件、148 项测试全部通过。

生产构建：

```powershell
npm run build
```

结果：Next.js 生产构建成功，TypeScript 检查通过，131 个页面生成完成。

全量基线：

```powershell
npx vitest run --config tests/vitest.config.js --reporter=dot
```

结果：165 个测试文件通过、25 个失败；1726 项测试通过、68 项失败、15 项 expected-fail、63 项跳过。失败集中在仓库既有的 Cursor 协议导出、数据库并发、Windows 路径、旧 golden snapshot、外部 live 测试及翻译器基线；本次 Qoder/Codex 相关测试全部通过。全量运行产生的无关 golden snapshot 更新已恢复到入口 `HEAD`。

原始最小复现已重新运行并转绿，用户报告的“首次 socket 断连直接 502”和“断连后账号池逐个锁定”均由回归测试覆盖。

未加入临时生产埋点，未发送付费模型请求，未修改生产数据。没有 `[DEBUG-*]` 临时日志；现有工作区中上一功能的未跟踪验证文件保持原样并排除在本修复范围外。

## 后续架构建议

Qoder 因签名、队列和 SSE 包装而覆盖了 `BaseExecutor.execute()`，导致通用网络重试能力无法自动复用。后续可把“首响应前传输重试、请求身份刷新、keepalive 和错误分类”抽成执行器可配置的公共协调器，Qoder 只提供重签名回调。该改造能减少不同执行器之间的恢复语义漂移，但会触及所有 provider，超出本次生产故障修复范围。
