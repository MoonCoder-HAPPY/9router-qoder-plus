# 10 — 端到端验收与灰度发布

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §16.4/§16.5/§16.6/§16.10、§18）
- **Problem source**：改造必须用真 Codex 客户端验证，且生产切换需可回滚
- **What to build（端到端行为）**：
  1. 服务器上用真 Codex CLI（`codex exec --json`）跑三场景（纯问答 / 工具链 / 长上下文），事件级断言通过且无 `Unknown model … fallback` 警告
  2. 构建新镜像（沿既有 overlay 流程），先起回滚容器 `9router-before-codex-ux-<日期>`，保留 v39c
  3. 单 Key 灰度 24h → 观测指标达标 → 再全量切生产
- **Delivery goal**：以证据完成交付并具备一键回滚
- **Modification scope**：验收脚本（`scripts/` 或 `.spec-workflow/.../research/`，非生产代码）+ 服务器构建/容器操作 + 报告
- **Acceptance criteria**：三场景日志与事件断言证据齐全；灰度 24h 内无重启、失败率下降；切换与回滚步骤在 `implementation-report.md` 留痕
- **Dependencies**：03–09
- **Blocked by**：03、04、05、06、07、08、09
- **Status**：ready-for-agent
- **Priority**：P0（交付收口）
- **Blocks delivery**：是
- **Can run in parallel**：—
- **Parallel boundary**：生产切换前必须暂停并获得用户确认
- **Input context for spec-do**：spec §18 回滚方案；服务器 `175.178.223.16`（容器 `9router`，数据目录 `/home/ubuntu/.9router`）；部署流程见既有 overlay 实践