# 9Router 测试套件

本目录承载仓库的全部自动化测试（Unit / Translator golden 等），以及 CI 使用的“基线门禁”。

## 运行方式

vitest 是仓库根目录的 devDependency，在根目录执行一次 `npm install` 即可，无需在 `tests/` 下再次安装。

```bash
# 全量回归（推荐）：只对“新增失败”报红
node tests/scripts/check-baseline.mjs

# 只跑本次改动的相关套件
npx vitest run --config tests/vitest.config.js unit/request-key-entry.test.js

# 监听模式
npx vitest --config tests/vitest.config.js
```

从仓库根目录执行即可；`tests/vitest.config.js` 已配置 `open-sse/` 与 `@/` 别名，脚本无需关心相对路径。

## 基线门禁

仓库存在一批与当前工作无关的历史失败（golden 快照、legacy translator 归一化、Windows 临时目录清理的 EPERM、可选依赖缺失等），因此 CI 不要求“全绿”，而是要求**不新增失败**：

- 已知失败清单：`tests/__baseline__/known-fails.txt`（一行一条 `相对路径 :: 完整用例名`）。
- 门禁脚本：`tests/scripts/check-baseline.mjs`；有新增失败时列出条目并以非零码退出。
- 修复了历史失败后，可用 `node tests/scripts/check-baseline.mjs --update` 收缩清单（请在独立提交中说明原因）。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `unit/` | 主测试目录：provider/executor、translator 行为、dashboard 接口与组件契约、额度与 Key 策略等 |
| `translator/` | 翻译层与 golden 快照测试（含 `__snapshots__/`） |
| `scripts/` | `check-baseline.mjs` 基线门禁 |
| `__baseline__/` | 已知失败清单，供门禁比对 |

## 编写新测试

- 文件命名 `*.test.js`，放在 `tests/unit/` 对应领域下；需要真实文件系统或 SQLite 时请使用临时目录，并在用例结束后清理。
- 不依赖真实上游凭证：涉及 provider 网络的用例应注入假 fetch 或使用 fixture，真实付费调用一律不进 CI。
- 与 dashboard 交互相关的回归，优先断言真实请求/响应或组件行为，而不是源码字符串；纯源码契约检查只作为补充。
- 新增测试若因环境（例如 Windows）在 CI 之外失败，请勿把它写进 `known-fails.txt` 来“消音”，应在用例内显式跳过并注明原因。