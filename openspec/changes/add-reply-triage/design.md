# 消息分级与调度技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [reply-triage 规格](specs/reply-triage/spec.md)。

`Store.ingest()` 以 `INSERT OR IGNORE` 写入 `messages`，状态为 `queued`；`Store.pending(limit, account)` 按 `created_at DESC` 取前 `limit` 条。`Workflow.tick()` 对每条依次检查遗忘、`maxAgeHours`、通道冷却、unknown 和小时额度，不满足就 `continue`——被跳过的条目已经占用了本轮名额。`created_at` 来自事件的平台时间（不可靠时为 0）。`parseDraft()` 只接受 `{action,text,reason}`。私信采集本来只把会话最后一条明确入站的消息作为事件。公开小时额度由 `sentCount()` 合并 outbox 与旧消息计算；平台拒绝时 `rejectChannel()` 设置四小时冷却。

## Goals / Non-Goals

**目标：** 全部分级、过滤、合并和名额分配都在本地确定性完成；与现有额度、退避、unknown 只回查、草稿审核和遗忘语义叠加而不改变它们；规则参数可调并可解释。

**非目标：** 不用模型分类；不在平台执行屏蔽、静音、举报；不做跨渠道身份合并；不自动调整小时额度；不处理私信的多消息合并（采集已只取最后一条入站）。

## Decisions

### 1. 分级规则（`src/triage.ts`）

纯函数 `classify(event, history, settings)` 返回 `{tier:'priority'|'normal'|'skip'|'filtered', reason}`，按顺序判定，第一条命中即返回：

1. **过滤**：广告（正文含链接且命中广告关键词，或除提及与标签外只剩广告关键词；关键词表默认含返利、代理、空投、airdrop、giveaway、加V、互关涨粉等，可配置），或批量刷量（见第 3 节）。
2. **重点账号**：`channel=public` 且 handle 在名单，或 `channel=private` 且会话标识在名单 → 优先。
3. **无内容招呼**：去掉提及、emoji、标点后为空，或属于内置招呼词表（hi、hello、在吗、在么、你好、嗨、哈喽、早、晚安等，可配置）且不超过六个字符。老面孔 → 跳过；新人 → 普通。
4. **老朋友**：同账号同渠道三十天内已有三条及以上已处理消息，且不属于第 3 条 → 优先。
5. **首次来访**：同账号同渠道没有任何历史消息 → 优先。
6. **较长或提问**：去掉提及后不少于二十个字符，或包含问号及常见疑问结构（怎么、为什么、如何、能不能、是不是、哪里、多少，排除单独的“在吗”） → 优先。
7. 其他 → 普通。

历史统计只查 `messages`，按 `(account_id, user_id, channel)` 已有索引，限定三十天。规则与词表放在面板设置 `triage` 段，带默认值与修订号。

*备选*：调用模型做分级。成本与延迟在限速场景下不划算，且分级要在入队时完成，被否决；模型仍在生成时通过跳过类别兜底。

### 2. 数据与状态

迁移版本 9 为 `messages` 增加可空列 `tier TEXT`、`tier_reason TEXT`、`merged_into TEXT`，新增索引 `(account_id, status, tier, created_at)`。新增状态：`filtered`（入队过滤）、`merged`（被合并）、`ignored`（骚扰忽略期内）。超时与分级跳过沿用 `skipped`，`error` 写原因类别。新增表 `triage_ignores(account_id, user_id, channel, until, reason, strikes_json, PRIMARY KEY(account_id,user_id,channel))`。`processed_seq` 对新状态的处理与 `skipped` 一致，使记忆整理进度不受影响；`filtered`、`ignored` 的原文不进入记忆召回。

迁移时把已有 `queued` 行的 `tier` 置空；出队前对 `tier IS NULL` 的排队消息补分级，避免迁移脚本依赖运行时设置。

### 3. 批量刷量

正文规范化（NFKC、去提及、去链接、去空白和标点、小写）后取 SHA-256 前 16 字节，写入内存加 SQLite 的滑动窗口表 `triage_text_hits(account_id, hash, user_id, at, message_id)`，以账号与消息标识去重，保留一小时；使用可靠平台时间，不将迟到旧消息重新计入当期窗口。同一 hash 不同用户数达到阈值（默认 3）时，本条与仍为 `queued` 的同 hash 消息全部置为 `filtered`。规范化后少于六个字符的正文不参与（避免把“早安”判为刷量）。

### 4. 出队与名额分配

每轮先计算可发送通道集合：冷却未过、小时额度未满、每日额度未满（公开）、没有该通道的待回查 unknown；`draft` 模式下额度不限制生成，与现状一致。`pending(limit, account, channels)` 查询改为：

```sql
WHERE status='queued' AND account_id=? AND channel IN (...)
ORDER BY CASE tier WHEN 'priority' THEN 0 ELSE 1 END, created_at DESC
LIMIT ?
```

时效检查放在出队后、生成前：优先使用 `maxAgeHours`，普通使用 `normalMaxAgeHours`（默认 3，范围 1 至 `maxAgeHours`）。超时条目不占名额：循环在未达到 `maxPerRound` 实际生成数之前继续取下一条，每轮最多检查 `maxPerRound × 10` 条，防止长队列拖慢轮次。

*备选*：只调整排序不过滤通道。仍会被受限通道占位，被否决。

### 5. 公开消息合并

出队得到公开消息后，查询同账号、同用户、同 `conversationId`、状态为 `queued` 且平台时间在三十分钟窗口内的其他消息。选取平台时间最新者生成，其余置为 `merged` 并写 `merged_into`；其正文按时间顺序加入本次生成的【当前对话】上下文（标注为同一用户先前的消息）。同一用户在其他会话、两小时内已有一条被回复的后续消息，在分级时降为普通，原因写“同一用户的后续消息”。

### 6. 跳过类别与骚扰冷却

`parseDraft()` 接受可选 `category`，取值 `harassment|spam|no_reply|other`；缺失或其他值记为 `other`，不使解析失败。固定系统约束追加一句类别说明（属于稳定前缀，与 `improve-reply-prompt-context` 的分层兼容）。`harassment` 时在 `triage_ignores.strikes_json` 记录时间，二十四小时内达到三次即设置 `until = now + 24h`。入队与出队时检查忽略：忽略期内新消息置为 `ignored`。解除忽略清空 `until` 与 strikes。记忆摘要提示词已有“不推断身份或敏感标签”约束，本提案不向记忆服务传递任何骚扰信息。

### 7. 公开每日额度

`dailyCount(account)` 统计北京时间当日 `outbox`（公开回复与帖子，状态 confirmed、submitting、unknown）与未进入 outbox 的旧公开消息，与 `sentCount()` 同口径但按自然日。`publicPerDay` 默认 180，范围 1–1000。早晚安任务在提交前同样检查；超出时任务记录“每日额度已满”，按现有错过窗口规则处理，不重试。达到每日额度只影响可发送通道集合，不写冷却键，因此不触发四小时退避。

`add-account-aware-post-limits` 识别到的长帖权限不自动提高每日额度；是否按账号能力调整留待后续。

### 8. 界面与 CLI

主程序队列区（或 `simplify-panel-activity-feed` 落地后的设置页“排查问题”区）显示各级排队数、最长等待、今日公开提交数／每日额度、过滤／合并／忽略计数；动态首页的“待处理”筛选包含优先与普通。新增接口：`GET /api/triage/summary`、`POST /api/messages/:id/requeue`（拒绝 unknown、sending）、`GET/DELETE /api/triage/ignores`。重点名单与参数沿用面板设置保存。CLI `retry` 扩展到 `filtered`、`merged`、`ignored`。

## Risks / Trade-offs

- [规则误判，把正常消息过滤或降级] → 原因可见、可手动重新排队；广告必须同时满足链接与关键词；刷量要求不同账号且正文足够长。
- [老面孔的“在吗”被跳过显得冷淡] → 只对无内容招呼生效，重点名单不受影响；词表与开关可配置。
- [合并后回复只针对最新一条] → 较早消息作为上下文进入生成，避免答非所问。
- [每日额度过保守] → 默认值可调；平台拒绝仍走原退避作为最后防线。
- [新状态影响回退] → 旧 `rollback-schema.py` 继续拒绝新库；面向已发布七页基线的 `prepare-proposals-rollback.py` 保留全部表、列、迁移及 `filtered`／`merged`／`ignored` 原状态和原因。这些非 queued 终态不会被旧版重新生成；存在仍生效的骚扰冷却时拒绝兼容准备，防止旧版无法执行冷却却恢复业务。

## Migration Plan

1. 迁移版本 9 增加列、索引和两张表，可重复执行；旧 `queued` 行在首轮补分级。
2. 发布前在服务器 staging 用脱敏历史消息回放分级，统计各级比例与过滤样本，人工复核误判。
3. 回退：旧 `rollback-schema.py` 保持针对七页以前数据库的降级门禁，拒绝新迁移。新增 `deploy/prepare-proposals-rollback.py` 仅对已暂停、确认离线的版本 0.1.16 兼容准备执行只读 `--check` 或显式 `--apply`：完整保留新结构、分级终态与原因；有效骚扰冷却、未收束提交、未知结构和无法安全回查的长帖 unknown 均拒绝。批准及待重写的 queued 转为 draft，冻结正文和复核元数据不变；不删除分级表或清空冷却。事务失败整笔回滚，成功也不代表可以恢复业务。管理员须按实际账号与旧版本功能差异另行核对。

## Verification

- 单元测试：分级规则顺序与各条边界；招呼词与长度；刷量阈值与短文本排除；合并窗口；骚扰计数与到期；每日额度跨零点；类别解析容错。
- 集成测试：公开受限时私信被处理；超时条目不占名额；被过滤消息无 `llm_calls`；重新排队拒绝 unknown；每日额度不写冷却键；忽略状态不进入记忆摘要输入。
- 所有构建与测试在服务器隔离环境执行。
