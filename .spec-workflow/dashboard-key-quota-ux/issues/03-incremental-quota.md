# 03 账号增量加载与所选账号保存校验

Status: done
Priority: P1
Blocked by: none
交付阻塞：是。可并行：与 01/02 独立；与 04 串行。写入限 quota-options、Key 更新校验、限制弹窗和专属加载辅助/测试。

来源：`../requirements.md` 第 3 项；权威规格 `../spec.md`。
交付：身份首帧、余额逐条到达，有界并发/超时，前端独立行状态；保存不等未选账号。
验收：慢失败账号不阻止快行显示，未知余额非 0，所选未就绪不能保存，取消/切 Key 不污染；保留原 JSON 消费者。
Input context for spec-do：spec.md、本文件，quota-options route、keys/[id] PUT、ApiKeyRestrictionsModal、apiKeyPolicy 服务及额度测试。
