# 02 — prefactor：Codex 适配配置骨架

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §9.1、§10.1、§15.1、§7.1）
- **Problem source**：本轮新增的阈值/开关散落在多个模块会难以维护与回滚，需先建立唯一配置入口
- **What to build（端到端行为）**：管理员在 Dashboard 设置页看到「Codex 适配」分组，可读写 7 个配置项并即时生效；非法值被拒并提示；默认值在无配置时自动生效（当前行为不变）
- **Delivery goal**：为 03/06/07/08 提供统一配置与阈值计算入口，避免硬编码
- **Modification scope**：
  - 新增 `src/shared/services/codexCompat.js`：默认值、读写、校验、`computeAutoCompactLimit(contextWindow)`（`clamp(窗口×ratio,min,max)`）
  - `src/lib/db/repos/settingsRepo.js` 增加 `codexCompat` 默认段；`src/app/api/settings/route.js` 支持读写
  - `src/app/(dashboard)/dashboard/profile/page.js`（或设置页对应文件）新增分组与中文文案；`public/i18n/literals/zh-CN.json` 同步
- **Acceptance criteria**：默认值断言通过；越界值（ratio>1、min>max、负数）被拒；`proactiveContextGuard=false` 时不影响现有行为
- **Dependencies**：无（与 01 为并行的前置性工作）
- **Blocked by**：—
- **Status**：ready-for-agent
- **Priority**：P0
- **Blocks delivery**：是（03/06/07/08 依赖）
- **Can run in parallel**：是（与 01/04/05 并行）
- **Parallel boundary**：只新增配置/设置相关文件与 i18n 字面量
- **Input context for spec-do**：spec §10.1 配置项与默认值表；既有 `modelIdleAlert` 配置实现可作模板（`src/shared/services/modelIdleAlert.js` + `settings` API + Profile 页表单）