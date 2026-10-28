# 私信每日额度技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [reply-triage 规格](specs/reply-triage/spec.md)。以下现状来自 2026-10-28 本机提交 `5c1a4c3` 和生产服务器只读核对：

- **发送判断**：`Workflow.channelWaitReason(channel, c, sending, excludeUnsubmittedId)` 依次检查退避、待回查 unknown 和额度，返回 `cooldown`、`unknown-pending` 或 `quota`。额度部分：
  - 小时额度：`sentCount(channel)` 统计最近一小时的 outbox（含被拒绝）和未进入 outbox 的旧消息，与 `publicPerHour`／`privatePerHour` 比较；
  - 公开每日额度：`ReplyTriage.dailyCount(account)` 按北京时间自然日统计公开 outbox（confirmed、submitting、unknown）和旧公开消息，与 `publicPerDay` 比较；
  - 正在发送的已批准草稿用 `hourlyAdjustment`／`dailyAdjustment` 扣掉自己，避免被自己占满。
- **调用方**：
  - 主循环选择可发送通道时，以 `sending = (mode === 'auto')` 调用，草稿模式不检查额度；
  - 已批准草稿提交前调用，额度不足时保持 `approved` 并写入 `draft.waitReason`；
  - 早晚安任务只检查公开通道。
- **等待原因显示**：`public/js/views/feed.js` 有 `quota`（本小时额度已用尽）和 `daily-quota`（今日公开额度已用尽）两种文案，但服务器对公开每日额度也只返回 `quota`，`daily-quota` 从未出现。
- **设置**：额度保存在面板设置 `program` 分区。`mergePanel` 只复制白名单字段；`config.ts` 和 `PUT /api/program/settings` 各自校验范围（`publicPerDay` 1–1000，`privatePerHour` 1–100）。
- **摘要**：`GET /api/triage/summary` 返回 `publicToday` 和 `publicPerDay`，队列设置页显示“今日公开额度 n / 180”。
- **健康**：
  - 自动化拦截告警写明“每小时 X，每日 Y”，私信的每日部分固定为“未设置”；
  - `fallbackSendable` 只在调用方没有传入可发送通道时使用，只检查退避、unknown 和小时额度。
- **`ReplyTriage.allowedChannels`**：只有单元测试调用，接收 `publicPerDay`。
- **生产**：outbox 只有一条公开回复（unknown），`messages` 和 outbox 中私信都是零条。

## Goals / Non-Goals

**Goals：**

- 任意连续二十四小时内，系统提交的私信不超过私信额度。
- 达到额度只让私信等待，不影响公开通道，也不进入退避。
- 管理员能在面板看到并调整私信额度。

**Non-Goals：**

- 不改公开每日额度的统计方式，也不修正公开每日额度显示成“本小时额度已用尽”的问题（见 Risks）。
- 不统计管理员接管时手动发送的私信。
- 不按账号认证状态调整额度。
- 不新增数据库结构。

## Decisions

### 1. 按最近二十四小时滚动统计

窗口为 `(now − 24h, now]`。X 没有公布私信的计算时区和时间窗；滚动窗口能覆盖任何一种算法，包括任意时区的自然日。按北京时间自然日统计时，每小时 30 条的设置在零点前后各十二小时可以发 720 条，超出 X 的上限。

代价是名额逐条释放，不像自然日在零点一次全部恢复；私信是被动回复，这个差别可以接受。

### 2. 默认 400，范围 1–500

上限取 X 公布的 500。默认 400 留出 100 条给管理员手动私信。字段名 `privatePerDay`，与 `publicPerDay` 对应；界面和文档写“24 小时”，不写“每日”，避免误解成自然日。

### 3. 计数函数

`ReplyTriage` 新增 `privateRecentCount(accountId, at = now)`，口径与 `dailyCount` 一致，只把时间范围换成滚动窗口：

- outbox 中 `channel = 'private'`、状态为 confirmed、submitting、unknown，且 `submitted_at` 在窗口内的条数；
- 加上 `messages` 中 `channel = 'private'`、状态为 confirmed、sending、unknown，`updated_at` 在窗口内，且没有对应 outbox 行的旧消息。

被拒绝的私信不计入。拒绝已经触发四小时退避，再占名额就重复惩罚了。

### 4. 发送判断与等待原因

`channelWaitReason` 在现有额度检查之后增加私信分支：

```text
channel === 'private' && triage 存在
  && privateRecentCount(account) − recentAdjustment >= (c.privatePerDay ?? 400)
  → 返回 'private-daily-quota'
```

- `recentAdjustment`：与 `dailyAdjustment` 同样的保留判断，条件改为 `excluded.updated_at > now − 24h`。
- 小时额度先检查。两者都满时返回 `quota`，与现状一致。
- 新等待原因在 `feed.js` 显示为“近 24 小时私信额度已用尽”。
- 不写冷却键。主循环和已批准草稿沿用现有的“非空即等待”处理，不需要另加分支。

`allowedChannels` 增加 `privatePerDay` 和 `privateRecentCount` 参数，保持与 `channelWaitReason` 相同的判断，并同步更新单元测试。

### 5. 配置与接口

- `Config` 增加 `privatePerDay?: number`；`mergePanel` 把它加入白名单，并在未设置时取 400。
- `config.ts` 和 `PUT /api/program/settings` 的校验范围为 1–500，非整数或超出范围时拒绝，原设置不变。
- `GET /api/program` 的 `settings` 返回 `privatePerDay`；`limits` 结构不变。
- `GET /api/triage/summary` 增加 `privateRecent`（窗口内计数）和 `privatePerDay`。

### 6. 界面

- 设置页“发送限制”在“公开每日上限”后加“私信 24 小时上限”（1–500）。
- 队列摘要在“今日公开额度 n / 180”后加“近 24 小时私信 n / 400”。
- 浅色、深色和 375px 宽度下不出现横向滚动。

### 7. 健康

- `HealthEvaluation` 增加 `privatePerDay`，由 `Workflow` 传入。
- 自动化拦截告警的私信文案改为“每小时 X，最近 24 小时 Y”。
- `fallbackSendable` 对私信加入同样的窗口检查。公开每日额度在这个回退判断里本来就没有检查，不在本提案中补。

## Risks / Trade-offs

- **手动私信不计数**：管理员接管时如果手动发了大量私信，系统仍可能按 400 继续发送。默认留了 100 条余量；需要大量手动私信时，管理员应先调低额度。
- **X 临时下调上限**：限制页写明高峰期可能临时降低上限。这时平台拒绝会触发现有的四小时退避，作为最后防线。
- **公开每日额度显示有误（不在本次范围）**：公开每日额度满时，界面显示“本小时额度已用尽”。修正方法是让服务器返回 `daily-quota`，可以另提。
- **私信尚未上线**：生产里私信是零条，无法在生产实际触发额度。达到额度的行为只能在服务器隔离环境用可控时钟验证，生产只读回配置。

## Migration / Rollback

数据库结构不变，没有迁移。旧版本 `mergePanel` 不复制 `privatePerDay`，会忽略这个字段，回退后不需要清理面板设置。回退期间私信只受小时额度限制，与现状相同。

## Verification

- **单元测试**（可控时钟）：
  - `privateRecentCount` 的窗口边界：恰好二十四小时前的一条不计入，晚一毫秒的计入；
  - rejected 不计入；旧消息计入，并且不与 outbox 重复计数；
  - 配置缺省为 400，0、501 和非整数被拒绝。
- **集成测试**（真实 Store、Outbox、Workflow，隔离 transport）：
  - 达到 400 时私信不占名额、公开照常处理，且不写冷却键；
  - 窗口滑过后私信恢复；
  - 跨北京时间零点不重置；
  - 草稿模式仍然生成；
  - 已批准私信草稿在额度满时保持 `approved`，`waitReason` 为 `private-daily-quota`。
- **界面验收**：设置字段和队列摘要，覆盖浅色、深色和 375px。
- **服务器全量**：类型检查、全量回归和构建。所有构建与测试只在服务器隔离环境执行，不使用生产 profile。
- **生产发布**（需要另行授权）：发布后用 `GET /api/program` 读回 `privatePerDay = 400`，队列摘要显示私信计数。
