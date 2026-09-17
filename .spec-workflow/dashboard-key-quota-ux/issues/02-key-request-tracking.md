# 02 API Key 请求身份追踪

Status: done
Priority: P1
Blocked by: none
交付阻塞：是。可并行：与额度设置独立；写入限请求处理身份、详情仓库/接口/页面及对应测试。

来源：`../requirements.md` 第 2 项；权威规格 `../spec.md`。
交付：调用时身份快照贯穿详情落库，下拉按身份筛选，行显示历史名称，同名不混淆。
验收：改名/删除后快照保留，旧未知与无 Key 区分，分页前过滤且总数正确，无明文 Key 泄露。
Input context for spec-do：spec.md、本文件，chatCore/requestDetail、各响应 handler、requestDetailsRepo、request-details route 与 RequestDetailsTab，现有详情测试。
