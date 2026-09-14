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