# 07 — auto-continue 加固

- **Parent / Source**：`codex-agent-ux@v1`（spec.md §16.7）
- **Problem source**：线上出现"宣布即停"（`Let me write it.` 后 stop、无 tool_call）；队列重试成功路径未接通续跑
- **What to build（端到端行为）**：带 tools 的回合若"宣布即停"，自动隐藏续跑 1 次并产出工具调用；经队列重试成功的请求同样具备该能力；续跑不引入空 reasoning 回合
- **Delivery goal**：会话不再因模型"说完就停"而中断
- **Modification scope**：
  - `open-sse/executors/qoder.js`：队列重试成功分支传入 `continueFetch`；续跑请求剔除空 reasoning 回合
  - 次数上限读 `codexCompat.autoContinueMax`
- **Acceptance criteria**：续跑次数=1 且仅带 tools 触发；队列路径断言通过；无 tools 请求不触发；续跑后的工具调用事件序列合法
- **Dependencies**：03（含其上游 02 的配置骨架）
- **Blocked by**：03
- **Status**：ready-for-agent
- **Priority**：P1
- **Blocks delivery**：否（但影响体验验收）
- **Can run in parallel**：—
- **Parallel boundary**：只动 qoder 续跑与队列重试路径
- **Input context for spec-do**：spec §16.7；prior art `tests/unit/qoder-auto-continue.test.js`、`tests/unit/qoder-queue-stream.test.js`