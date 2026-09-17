# 04 快捷移除与空列表保护

Status: done
Priority: P1
Blocked by: 03-incremental-quota
交付阻塞：是。可并行：否，与 03 共享弹窗及保存入口。

来源：`../requirements.md` 第 4 项；权威规格 `../spec.md`。
交付：箭头旁 X，同步取消勾选与分配，保存后生效；前后端阻止开启限制时保存空列表。
验收：取消不落库、关闭限制保留原行为、不删除账号或调用重置、不影响其他 Key 和保留账号用量。
Input context for spec-do：spec.md、本文件、03 结果，ApiKeyRestrictionsModal、keys/[id] PUT 与 policy 测试。
