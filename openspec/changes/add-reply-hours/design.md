# 回复时段跟随早晚安帖技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [reply-hours](specs/reply-hours/spec.md)、[reply-triage](specs/reply-triage/spec.md) 和 [runtime-health](specs/runtime-health/spec.md) 增量规格。以下现状来自 2026-10-28 本机提交 `5c1a4c3` 和生产服务器只读核对：

- **任务计划**：`Scheduler.plans()` 把 `DEFAULT_TASK_PLANS` 和面板设置 `tasks.plans` 合并。早安默认 `{enabled:false,time:'08:00'}`，晚安默认 `{enabled:false,time:'23:00'}`；生产没有覆盖，即两个任务都停用。`plannedAt(time, now)` 按北京时间算出当天计划时刻。
- **早晚安执行**：
  - 非运行中或非自动模式时，任务实例直接记为 `skipped`；
  - 计划时间后超过五分钟记为 `missed`；
  - 实例状态包括 running、completed、failed、interrupted、unknown、missed、skipped、cancelled，存在 `task_runs`，以 `(task_id, account_id, scheduled_at)` 唯一；
  - 发帖前调用 `channelWaitReason('public')` 检查额度。
- **主循环 `Workflow.tick()`**：
  1. 采集并入队（`triage.ingest`），刷新分级（`refreshQueued`）；
  2. 处理已批准草稿的提交（约第 160 行，等待时写 `draft.waitReason`）；
  3. 按 `channelWaitReason` 选可发送通道，取 `pending` 生成。
- **超时判断有多处**：
  - `queuedEligibility` 的 SQL 按级别比较 `m.created_at`；
  - `refreshQueued`／`apply` 标记超时；
  - `workflow.ts` 第 136、164、214 行用 `Date.now() - e.timestamp > maxAgeHours` 跳过。
- **出队顺序**：同级内平台时间较新者优先。
- **健康**：
  - 成功发送停滞的基线为 `max(最近确认发送, 可发送通道中最早排队消息)`；
  - `pendingByChannel` 来自 `triage.healthQueue`；
  - 日报的 `responseLatencyMs` 是收到到确认之间的时长。
- **生产**：`maxAgeHours = 6`，普通时效为默认三小时，`program.mode = 'auto'`。

## Goals / Non-Goals

**Goals：**

- 关闭时段内不生成、不提交任何回复和私信，其他任务不受影响。
- 早安帖先于当天第一条回复。
- 夜间消息早上补回，等待时长和健康、日报指标都扣除关闭时长。
- 开关时间对管理员可见，可以整体关闭这个功能。

**Non-Goals：**

- 不改早晚安帖的发送规则和五分钟窗口。
- 不改采集频率，夜里照常采集。
- 不按虚构日程动态调整时段。
- 不改出队顺序、额度、退避和 unknown 只回查。
- 不新增数据库结构。

## Decisions

### 1. 设置

面板设置 `program.replyHours = { enabled: boolean, closeDelayMinutes: number }`，缺省 `{ enabled: true, closeDelayMinutes: 30 }`。

- `PUT /api/program/settings` 和 `config.ts` 校验：`enabled` 为布尔值，`closeDelayMinutes` 为 0–180 的整数，否则拒绝并保留原设置。
- `mergePanel` 把它复制到 `Config.replyHours`。
- 开关时间不单独保存，始终读当前早晚安任务计划。管理员改任务时间，回复时段随之改变；设置页显示算出的区间，让这种联动可见。

### 2. 时段计算（`src/reply-hours.ts`）

纯函数 `replyWindow(input)`：

- 输入：`now`、`enabled`、`closeDelayMinutes`、早安计划 `{enabled,time}`、晚安时间，以及早安实际终态。生产一次只读该账号已有终态记录，通过 `morningRunEnds` 传入；`morningRunEnded(scheduledAt)` 查询函数保留为兼容入口。
- 输出：`{ open, reason, closedAt?, opensAt?, closesAt? }`、供原有展示使用的近期关闭区间列表，以及内部有效等待规则 `agePolicy`。内部规则不进入管理接口 DTO。

规则：

- 一天的关闭区间是 `[晚安计划时刻 + 延迟, 次日早安计划时刻)`，按北京时间换算成时间戳。晚安时间加延迟跨零点、或晚安时间本身在零点后，都按“时刻轴上下一个早安时刻”计算。
- 区间结束点总是取关闭点之后的第一个早安时刻，所以任意时间组合都有确定的区间。晚安加延迟恰好等于早安时间时，区间长度为零，不关闭。
- 开放点：早安任务启用时，取 `min(当天早安实例进入终态的时刻, 计划时刻 + 15 分钟)`；没有实例时只看 15 分钟上限。早安任务停用时，开放点就是计划时刻。
- “终态”指 running 以外的全部状态。interrupted 和 unknown 也算结束，这时帖子是否发出未定，但不应该继续挡住回复。
- 15 分钟上限覆盖了五分钟窗口、模型调用和浏览器提交的常见耗时。超过后即使任务仍在运行也开放，避免卡住的任务挡住全天回复。

`reason` 取 `reply-hours-closed` 或 `waiting-morning-post`，界面分别显示“回复时段已关闭”和“等待早安帖发出”。

### 3. 主循环接入

- 每轮开始时计算一次 `replyWindow`。关闭时照常采集、入队、刷新分级，不进入已批准草稿提交和生成两步。已批准草稿的 `draft.waitReason` 写入 `reason`，与现有额度等待的写法相同。
- 时段检查不放进 `channelWaitReason`：早晚安任务也调用这个函数，放进去会挡住早安帖本身。
- 草稿模式同样受时段限制：夜里不生成草稿，管理员批准的草稿等开放后提交。
- 动态页的“重新生成”等手动操作只是唤醒主循环，关闭期间同样等待。人工接管不经过主循环，不受影响。

### 4. 等待时长扣除关闭时长

`effectiveAge(receivedAt, now, source)` 与 `effectiveAgeSql(field, at, source)` 共享有效等待口径。`source` 可以是兼容的显式关闭区间数组，也可以是内部 `ReplyAgePolicy` 周期规则。

- 原“只需最近四十八小时关闭区间”的实现假设已由确定性红测证伪：配置允许四十八小时有效时效，每天只开放一分钟时，对应的日历跨度可以达到 2,880 天。不能把固定展示窗口用作历史计时边界，也不能换成另一个固定天数。
- 近期 `closures` 仍用于原有状态展示；有效等待改用每日重复周期、关闭时刻、关闭时长和早安等待上限的数学原函数，两个端点之差不随历史跨度展开。实际早安终态以匹配当前计划时刻的例外补回提前开放时长，重复及交叠区间先合并，极短开放间隙也按真实并集计算。
- SQL 与纯函数共用同一周期规则。周期项按数学 `floor` 计数，不依赖 SQLite 可选数学扩展；例外使用一个 JSON 参数读取，不能按历史天数生成上千个 SQL 参数。旧显式区间数组仍先合并再扣除重叠。
- `queuedEligibility(maxAgeHours, options, at)` 支持显式历史时刻，未传入时沿用当前时刻。动态增量用同一规则比较上次水位和当前资格，自然过期也更新左栏徽标和优先状态，不以写入消息时间伪造变化。
- `refreshQueued`／`apply` 和 `workflow.ts` 三处 `Date.now() − e.timestamp` 改用 `effectiveAge`。每处保持原来使用的时间字段（`created_at` 或平台时间），只改计算方式。
- 关闭期间也不会把消息标记为超时，因为关闭时长不计入。

### 5. 健康与日报

- `Workflow` 把 `replyWindow` 结果传给 `health.evaluate`。关闭时，所有通道的 `sendableChannels` 视为不可发送，停滞指标保持正常；新增指标 `reply-hours`，关闭时为正常级别，说明“回复时段已关闭，HH:MM 开放”。
- 开放后，停滞基线增加一项开放时刻：`max(最近确认发送, 可发送最早排队, 最近开放时刻)`。
- 日报的 `responseLatencyMs` 对每条样本使用 `effectiveAge(收到, 确认, agePolicy)`；日报虽然统计前一自然日，样本可能在更早日期入队，因此仍扣除收到至确认之间的全部关闭时长，不作四十八小时截断。

### 6. 接口与界面

- `GET /api/program` 返回 `settings.replyHours`，另加 `replyHours: { open, reason, opensAt, closesAt, closeTime, openTime }`。`closeTime` 和 `openTime` 是按当前任务时间算出的 `HH:MM`。已有近期 `closures` 展示保持兼容，内部 `agePolicy` 和全历史早安例外不得直接返回。
- 设置页“发送限制”增加开关和“晚安后关闭延迟（分钟）”，下方显示“每天 23:30–08:00 不回复（早安 08:00、晚安 23:00 来自任务计划）”。
- 动态页顶部在关闭时显示“回复时段已关闭，08:00 开放”。`feed.js` 的等待原因增加 `reply-hours-closed`（回复时段已关闭）和 `waiting-morning-post`（等待早安帖发出）。
- 浅色、深色和 375px 宽度下不出现横向滚动。

## Risks / Trade-offs

- **早上集中回复**：夜里积攒的消息在开放后集中处理，可能显得像机器人批量回复。速度仍受每轮条数、每小时额度和 X 的半小时限制约束，不会瞬间发出一大批。需要更平缓时，可以另提开放后的爬坡速率。
- **积压时较新的优先**：现有顺序是同级内较新者优先，早上新来的消息会排在夜间消息前面。积压超过额度时，部分夜间消息可能在开放后满时效仍未轮到而超时。本提案不改出队顺序。
- **任务时间改动会影响回复**：管理员把早安改到 10:00，回复也推迟到 10:00 开放。设置页直接显示算出的区间来降低误操作。
- **夜里照常访问 X**：夜间每分钟采集，浏览器活动与“睡觉”的设定不完全一致。本提案保证早上能补回，减少夜间访问另提。
- **时钟与时区**：全部按北京时间和服务器时钟计算，沿用调度器的 `plannedAt`，不引入新的时区逻辑。

## Migration / Rollback

数据库结构不变，没有迁移。

- 上线后功能默认开启：第一次进入关闭时段的当晚，回复会按 23:30–08:00 停止。发布记录要写明这一点。
- 回退时旧版本忽略 `program.replyHours`，恢复全天回复。夜间积压的消息按旧时效处理，超时的记为跳过。

## Verification

- **单元测试**（`test/reply-hours.test.ts`，可控时钟）：
  - 默认 08:00／23:00／30 分钟的开关点；跨零点的晚安时间；零长度区间；
  - 早安启用时等实例终态，覆盖 completed、failed、missed、interrupted、unknown；
  - 15 分钟上限；早安停用直接开放；功能关闭；
  - `effectiveAge` 跨一个和两个关闭区间。
- **分级测试**：`queuedEligibility` 和 `refreshQueued` 扣除关闭时长，覆盖规格中的“跨夜等待”和“积压超过额度”。
- **集成测试**（真实 Store、Outbox、Workflow，隔离 transport 和生成器）：
  - 关闭期间采集入队但零 `llm_calls`、零提交；
  - 已批准草稿保持 `approved` 并显示等待原因，开放后提交；
  - 早安任务在关闭状态下照常执行；
  - unknown 照常回查；
  - 开放后夜间消息被处理；
  - 草稿模式同样受限。
- **健康测试**：关闭期间不判停滞；开放后 20 分钟内不判停滞；日报延迟扣除关闭时长。
- **设置测试**：缺省值；`closeDelayMinutes` 取 0、180 可保存，-1、181 和非整数被拒绝。
- **界面验收**：设置页区间显示与动态页关闭提示，覆盖浅色、深色和 375px，截图存入证据目录。
- **服务器全量**：类型检查、全量回归和构建。所有构建与测试只在服务器隔离环境执行，不使用生产 profile。
- **生产发布**（需要另行授权）：发布后读回 `GET /api/program` 的 `replyHours`，当晚 23:30 后确认没有新的回复提交，次日 08:00 后确认开放并处理夜间消息。
