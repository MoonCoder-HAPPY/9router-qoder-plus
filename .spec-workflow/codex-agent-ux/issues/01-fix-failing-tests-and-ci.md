# 01 — prefactor：修绿现有失败测试 + CI 测试护栏

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §16.1/§16.2、§17）
- **Problem source**：fork 全量测试 102 failed / 1704（上游基线 85 failed / 1547 → 新增 19 个失败）；无测试 CI，护栏缺失
- **What to build（端到端行为）**：仓库根执行 `npx vitest run --config tests/vitest.config.js` 全绿；push 到任意分支时 GitHub Actions 自动跑同一命令并给出结果
- **Delivery goal**：后续所有工单有可用的自动护栏；测试结果可复现（Windows/Linux 一致）
- **Modification scope**：
  - 修 `tests/unit/xai-video-handler.test.js`、`tests/unit/gemini-native-endpoint.test.js` 的陈旧 `vi.mock("@/sse/services/auth.js")`（补 `buildApiKeyOptions` / `policyCredentialsResponse`）
  - 修 `tests/translator/bugs-openai-bridge.test.js` 自相矛盾断言（image-only `tool_result` 的占位文本与实现对齐）
  - 新增 `tests/scripts/check-baseline.mjs`（基线门禁：`--update` 重写基线，默认模式仅对"新增失败"报错）与 `.github/workflows/test.yml`（node 22 → 安装依赖 → 跑门禁）
  - 修正 `tests/package.json` 的 `test` 脚本为跨平台形式（现为 Unix-only `NODE_PATH=/tmp/...`）
- **Acceptance criteria**：`node tests/scripts/check-baseline.mjs` 输出 `OK - no new failures` 并以 0 退出；CI（`.github/workflows/test.yml`）跑该门禁；本需求相关测试（translator/qoder/responses/models）全绿；文档命令 `npm --prefix tests test` 跨平台可用
- **Dependencies**：无
- **Blocked by**：—
- **Status**：ready-for-agent
- **Priority**：P0（阻塞其它票）
- **Blocks delivery**：是
- **Can run in parallel**：是
- **Parallel boundary**：只动 `tests/**`、`.github/**`、`tests/package.json`，不碰 `src/**`、`open-sse/**`
- **Input context for spec-do**：spec `.spec-workflow/codex-agent-ux/spec.md`；本票路径；命令 `npx vitest run --config tests/vitest.config.js`（CWD=仓库根，`path.resolve` 型用例依赖此 CWD）