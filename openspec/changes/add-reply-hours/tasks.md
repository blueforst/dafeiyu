# 回复时段跟随早晚安帖实施任务

当前完成 9/10 项。服务器正式构建与 647 项回归通过，0.1.19 已部署并读回当前关闭状态；仅跨夜实际开放后的观察仍待完成，3.1 保持未勾选；证据见[本轮总记录](../../../docs/实施记录/2026-10-28-五项剩余提案候选.md)。规格见 [reply-hours](specs/reply-hours/spec.md)、[reply-triage](specs/reply-triage/spec.md) 和 [runtime-health](specs/runtime-health/spec.md)，实现边界见 [design.md](design.md)。构建和测试只在服务器隔离环境执行，不使用生产 profile；生产发布需要另行授权。实施前确认本机工作副本中涉及的源码、测试和前端文件没有其他人的未提交改动；如果 `add-private-daily-limit` 同时实施，需协调 `workflow.ts`、`reply-triage.ts`、`program.ts` 和设置页的改动。

## 1. 实现

- [x] 1.1 设置：`program.replyHours` 的缺省值、合并与校验（design.md 第 1 节）。验收：服务器测试覆盖缺省 `{enabled:true,closeDelayMinutes:30}`；0 和 180 可保存；-1、181、非整数和非布尔开关被拒绝，且原设置不变。
- [x] 1.2 时段计算：新增 `src/reply-hours.ts` 的 `replyWindow` 和 `effectiveAge`（第 2、4 节）。验收：`test/reply-hours.test.ts` 用可控时钟覆盖以下情况：
  - 默认开关点、跨零点、零长度区间；
  - 早安实例各终态与 15 分钟上限；早安停用；功能关闭；
  - 跨一个和两个关闭区间的等待时长。
- [x] 1.3 主循环：关闭时只采集、入队、刷新分级；已批准草稿写等待原因；草稿模式同样受限；`channelWaitReason` 不变（第 3 节）。验收：`test/limits-hours-workflow.test.ts` 新增用例，先在服务器上对修改前代码运行并失败，修改后通过。用例覆盖：
  - 关闭期间零 `llm_calls`、零提交；
  - 已批准草稿保持 `approved` 并在开放后提交；
  - 关闭状态下早安任务照常执行；
  - unknown 照常回查。
- [x] 1.4 时效：`queuedEligibility`、`refreshQueued` 和 `workflow.ts` 三处超时判断改用扣除关闭时长的等待时间（第 4 节）。验收：分级与集成测试覆盖“凌晨收到的普通消息”“关闭前已在排队”“跨夜等待”“积压超过额度”四个场景。
- [x] 1.5 健康与日报：关闭时不判停滞；新增 `reply-hours` 指标；停滞基线加入开放时刻；日报延迟扣除关闭时长（第 5 节）。验收：`test/unattended-health.test.ts` 覆盖夜间关闭、开放后 20 分钟内和日报延迟三个场景。
- [x] 1.6 接口：`GET /api/program` 返回 `settings.replyHours` 和当前 `replyHours` 状态（第 6 节）。验收：接口测试断言关闭和开放两种状态下的字段与 `HH:MM`。
- [x] 1.7 面板：设置页开关、延迟和区间显示；动态页关闭提示；两个新等待原因的文案。验收：服务器界面验收覆盖浅色、深色和 375px，无横向滚动，截图存入证据目录。
- [x] 1.8 服务器类型检查、全量回归和构建通过。验收：日志存入证据目录，失败、取消、跳过均为零。

## 2. 文档

- [x] 2.1 `docs/前端接口.md` 补充 `program.replyHours` 设置、`GET /api/program` 的 `replyHours` 状态和两个等待原因。验收：文档与实现一致。

## 3. 发布

- [ ] 3.1 取得发布授权后随下一次发布上线，保持原有控制状态，发布记录写明功能默认开启、当晚起 23:30–08:00 不回复。验收：读回 `GET /api/program` 的 `replyHours`；当晚关闭后的日志里没有新的回复提交；次日开放后夜间消息被处理，或队列为空时有日志说明。提案创建不视为发布授权。

发布步骤及待观察边界见[0.1.19 发布记录](../../../docs/发布记录/2026-10-29-0.1.19.md)。

## Workflow follow-up

- 本提案修改的 `reply-triage` 和 `runtime-health` 分别来自未归档的 `add-reply-triage` 和 `add-unattended-health`，归档时需要排在它们以及同样修改 `reply-triage` 的 `add-private-daily-limit` 之后。
- OpenSpec 严格校验通过只代表规划结构可用，不勾选任何业务任务。
