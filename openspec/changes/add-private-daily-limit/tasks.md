# 私信每日额度实施任务

当前完成 0/8 项。规格见 [reply-triage](specs/reply-triage/spec.md)，实现边界见 [design.md](design.md)。构建和测试只在服务器隔离环境执行，不使用生产 profile；生产发布需要另行授权。实施前确认本机工作副本中涉及的源码、测试和前端文件没有其他人的未提交改动。

## 1. 实现

- [ ] 1.1 配置：`Config`、`mergePanel`、`config.ts` 和 `PUT /api/program/settings` 支持 `privatePerDay`，缺省 400，范围 1–500。验收：服务器测试覆盖缺省值、1 和 500 可保存，0、501 和非整数被拒绝且原设置不变。
- [ ] 1.2 计数：`ReplyTriage.privateRecentCount` 按 design.md 第 3 节统计。验收：可控时钟单元测试覆盖窗口边界（恰好二十四小时前的不计入、晚一毫秒的计入）、rejected 不计入、旧消息计入且不与 outbox 重复。
- [ ] 1.3 判断：`channelWaitReason` 增加私信窗口检查并返回 `private-daily-quota`；`allowedChannels` 同步。验收：`test/triage-workflow.test.ts` 新增用例，先在服务器上对修改前代码运行并失败，修改后通过。用例覆盖：
  - 达到 400 时私信不占名额、公开照常处理、不写冷却键；
  - 窗口滑过后恢复，跨北京时间零点不重置；
  - 草稿模式仍生成；
  - 已批准私信草稿保持 `approved`，等待原因为 `private-daily-quota`。
- [ ] 1.4 健康：`HealthEvaluation` 传入 `privatePerDay`，自动化拦截告警的私信文案显示“最近 24 小时”额度，`fallbackSendable` 加入私信窗口检查。验收：`test/unattended-health.test.ts` 断言告警文案和回退判断。
- [ ] 1.5 接口与面板：`GET /api/program` 返回 `privatePerDay`；`GET /api/triage/summary` 返回 `privateRecent` 和 `privatePerDay`；设置页增加“私信 24 小时上限”；队列摘要显示“近 24 小时私信 n / 400”；动态页等待原因显示“近 24 小时私信额度已用尽”。验收：服务器界面验收覆盖浅色、深色和 375px，无横向滚动，截图存入证据目录。
- [ ] 1.6 服务器类型检查、全量回归和构建通过。验收：日志存入证据目录，失败、取消、跳过均为零。

## 2. 文档

- [ ] 2.1 `docs/前端接口.md` 补充 `privatePerDay` 字段和范围、`/api/triage/summary` 新字段、`private-daily-quota` 等待原因。验收：文档与实现一致。

## 3. 发布

- [ ] 3.1 取得发布授权后随下一次发布上线，保持原有控制状态；用 `GET /api/program` 读回 `privatePerDay = 400`，确认队列摘要显示私信计数。验收：写入发布记录；提案创建不视为发布授权。生产私信目前为零条，额度触发行为以 1.3 的隔离测试为准，不在生产制造私信。

## Workflow follow-up

- 本提案修改的 `reply-triage` 来自未归档的 `add-reply-triage`，归档时需要排在它之后。
- OpenSpec 严格校验通过只代表规划结构可用，不勾选任何业务任务。
