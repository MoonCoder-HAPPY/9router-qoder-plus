# Qoder 积分消耗列（Usage → 详情）

发布日期：2026-09-17
提交：`cdc839e`
镜像：`9router:qoder-credits-cdc839e`
生产：`175.178.223.16:20128`，容器 `9router`

## 需求

在 `使用量和分析 → 详情` 表格中，`输出 Token` 右侧新增一列，记录每次请求 Qoder 真实扣除的积分：

- 提供商是 Qoder → 显示真实扣除值；提供商不是 Qoder → 单元格为空（null）。
- 列标题右上角的说明按钮，鼠标悬停时解释该列只针对 Qoder 记录。

## 数据来源（未新增采集）

9router 早已把 Qoder usage 帧里的真实扣除值写入 `requestDetails.tokens.credits`，
`original_credits` 为折扣前原价。生产库实测（1000 条 Qoder 记录）：

| 指标 | 值 |
| --- | --- |
| 带 `credits` 的记录 | 969 |
| `credits` 与 `original_credits` 不同 | 11，且原价更高 |
| 示例 | `credits=0.1929` / `original_credits=0.4824` |
| 范围 | 0.0023715 … 5.297 |

结论：`original_credits` 绝不能作为显示兜底——那会把 0.1929 显示成 0.4824，虚报约 2.5 倍。
因此未记录扣费的行保持为空，而不是用原价或 0 填充。

## 实现

- `src/shared/utils/requestCredits.js`：provider 归一化、金额严格转换、格式化、单元格取值。
- `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`：新增第 8 列（标题、单元格、抽屉摘要），加载/空状态下 `colSpan` 由 7 改为 10（表格共 10 列，旧值本就不足）。
- `src/shared/components/Tooltip.js`：新增可选 `align` 属性，默认仍为居中，避免影响其它调用方；该列气泡锚定右侧、向下展开，不会被表格的横向滚动容器裁切。
- 说明按钮为真实 `<button>`，可键盘聚焦，而不是只能悬停的装饰 `<span>`。
- 文案：`Credits Used` → 中文 `Credits 消耗`（用户指定措辞）。

显示规则：四位小数、去尾零；真实但小于显示精度的小额扣费显示 `<0.0001`，避免被四舍五入成"免费"；
真实 0 显示 `0`；缺少记录显示 `—`。

## 验证

红灯→绿灯顺序如下。

1. 生产数据核对：确认 `credits` 语义与 `original_credits` 的差异（上表）。
2. 单元测试 `tests/unit/request-credits-column.test.js`：26 项，覆盖 provider 门控、拒绝原价兜底、
   真实 0 与缺失的区分、子精度显示、异常行不抛错，以及源码级锁定（列位置、按钮可聚焦、
   `colSpan` 与表头列数一致、中文文案、旧文案已清除）。
3. 全量回归：改动前基线 `670e0c2` 为 1643 通过 / 81 失败；改动后 1669 通过 / 81 失败。
   通过数正好 +26（新增测试），失败集合与基线一致，均为既有失败。
4. 生产构建通过。
5. 端到端（隔离数据目录 + 构建产物 + 真实 Chrome，CDP 驱动）：
   - 列位于 `输出 Token` 右侧（索引 6 → 7）；
   - Qoder 行显示 `0.0992`、`0.0024`，子精度显示 `<0.0001`；
   - 缺扣费的 Qoder 行为 `—`；带 `credits` 字段的 OpenAI 行仍为 `—`；
   - 说明按钮为 `BUTTON`，文案已本地化；
   - 悬停后气泡 `opacity=1`，且边界完全落在滚动容器内（未被裁切）；
   - 详情抽屉显示同一数值。

## 生产发布

- GitHub：`670e0c2..cdc839e` 已推送 `origin/main`。
- 镜像由 GitHub 归档构建（非本地上传）；构建前四个源文件 SHA-256 与本地逐一比对一致。
- 回滚点：容器 `9router-before-credits-cdc839e-20260917`（`9router:qoder-compaction-usage-47e4693`），
  v39b/v39c 等历史回滚容器与镜像全部保留，未执行任何 prune。
- 数据库备份：`/home/ubuntu/deploy/db-before-cdc839e-20260917-092417/data.sqlite`（50,286,592 字节）。
- 仅清理了 Docker 构建缓存（释放 5.1GB），未删除镜像。

### 一次自引入的部署缺陷（已修复，如实记录）

首次切换容器时，环境变量以单参数 `-e NAME=VALUE` 形式传入，Docker 将变量名解析为带前导空格的
`" NAME"`，导致 `JWT_SECRET`、`INITIAL_PASSWORD`、`REQUIRE_API_KEY` 等 19 个变量实际未生效，
时间窗口约 09:31–09:39（CST，约 8 分钟）。

处置与影响核实：

- 立即改用 `--env-file`（0600，用后即删）重建容器，并断言 `Object.keys(process.env)` 中不存在
  未 trim 的变量名；随后与部署前容器逐条 diff，环境变量名称与取值完全一致。
- 该窗口内数据目录不受影响：镜像自带 `DATA_DIR=/app/data`，容器仍挂载
  `/home/ubuntu/.9router`，`apiKeys=4`、`providerConnections=13`、`requestDetails=1000` 均正常，
  窗口内 34 条请求全部 `success`。
- `REQUIRE_API_KEY` 在运行时代码中无引用（仅文档/示例），不产生行为差异。
- 鉴权在窗口内回退到数据目录中的 `jwt-secret` 文件；当前容器已恢复读取 `JWT_SECRET`，两者值不同，
  因此该窗口内签发的会话令牌在修复后失效（需重新登录），不影响其它数据。

## 已知边界

- 未重新触发真实 Qoder 计费请求来验证扣费数值本身——该数值来自既有 usage 帧解析，
  已在生产数据中核对（见上表）；本次验证针对"展示是否忠实于已存数据"。
- 表格已支持横向滚动；抽屉内的同一数值仅在存在扣费时显示。
