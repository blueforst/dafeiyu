# 动态首页与面板精简技术设计

## Context

动机见 proposal.md。本设计基于已发布的 0.1.16 七页代码（`add-seven-page-production-bot` 尚有真实平台验收未完成）：

- 前端为原生 ES 模块，`public/js/app.js` 以 hash 路由懒加载 `views/*.js`；`state.js` 轮询 `/api/status` 并订阅 `/api/events`（SSE，每 5 秒推送 `logs`、`program`、`tasks`）。
- 消息存于 `messages`（`status` 为自由文本：queued、generating、draft、sending、unknown、confirmed、failed、skipped），草稿与回执以 JSON 存于 `draft`、`receipt` 列；出站正文存于 `outbox`，`UNIQUE(account_id,kind,source_id)` 冻结已准备的正文；早晚安帖是 `outbox.kind='post'`，`task_runs.outbox_id` 关联任务。
- `Workflow.tick()` 内联完成单条消息的上下文、记忆、人设组装、生成、草稿判断与发送；草稿模式在生成后 `continue`，没有任何路径再发送 `draft` 状态的消息。早晚安帖只在 `running` 且 `mode='auto'` 时发布。
- 浏览器操作经 `workflow.busy` 串行；手动任务在主程序忙时直接报错。
- 模型设置只有一份：`/data/panel/settings.json` 的 `model` 段（`PanelModel`），`mergePanel()` 把它转成 `Config.model`；Key 按 `provider@host` 分槽存于 `model-keys.json`；最近测试结果只有一条 `runtime['model:lastTest']`。
- 构建、测试和界面验收只在服务器执行（`dev/seven-*.sh`、`test/seven-pages-acceptance.mjs` 在 Camoufox 中用模拟接口）。

## Goals / Non-Goals

**Goals:**

- 动态时间线接口只读、按账号隔离、分页稳定，正文只出现在需要它的接口里。
- 人工批准的发送与自动发送共用同一段发送代码，不新增第二条通往 X 的写路径。
- 草稿操作接口不占用浏览器、不等待主循环，避免与 `busy` 互斥冲突。
- 模型库升级后旧版本仍能读取使用中模型，回退不需要转换设置文件。
- 前端改动复用现有视图中的表单和请求逻辑，不引入框架或构建步骤。

**Non-Goals:**

- 按用途分配不同模型（只在数据结构中预留 `active` 映射）。
- 草稿模式下的早晚安帖草稿化、已发送内容撤回。
- 改变语义触发、记忆整理、日程生成或计费口径本身。
- 改变浏览器 transport 的采集与发送实现。

## Decisions

### 1. 五页路由与旧地址

路由表改为 `feed`、`persona`、`memory`、`settings`、`billing`，地址格式 `#/<页面>[/<分区或标签>][?参数]`，例如 `#/settings/model`、`#/persona/daily`、`#/memory?account=…&user=…&channel=private`。`app.js` 维护旧地址映射：`overview→feed`、`model→settings/model`、`program→settings/logs`、`tasks→settings/tasks`、`browser→settings/browser`（展开并滚动到接管区）。映射用 `history.replaceState` 完成，不产生多余历史记录。离页保护沿用 `ctx.setLeaveGuard`；同页内切换分区或标签不触发离页保护，编辑稿留在内存中。

导航“动态”入口的待处理数字来自 SSE `feed` 事件（见第 3 节），各页面都能显示。

全局顶栏保留现有状态标签与暂停／恢复主按钮。动态页的概况行紧贴顶栏下方，只补充运行模式、使用中模型、登录账号及配置错误、退避、待回查和需要人工处理的提示，不放第二个暂停按钮；两者合起来满足“首页概况行”要求。原 `overview.js` 的三张卡片删除。

*备选*：保留七页、只做视觉精简。被否决，因为配置分散在四处是用户反馈的核心问题。

### 2. 动态接口

新增 `GET /api/feed?filter=all|pending|reply|dm|post&cursor=&limit=`（默认 30，上限 100），只返回 `workflow.accountId()` 名下的数据：

- 消息条目：来自 `messages`，解析 `body`（对方 handle、原文、原文链接、平台时间）、`draft`（回复正文、跳过原因、编辑与复核标记、等待原因）、`receipt`（平台链接）、`error`。
- 帖子条目：来自 `outbox WHERE kind='post'`，左连 `task_runs` 取任务 ID（早安／晚安）与运行 ID。
- 统一字段：`type`（reply／dm／post）、`id`、`at`、`status`、`revision`（消息 `updated_at`）、`expired`（按当前 `maxAgeHours` 计算，仅对 draft／approved）、`memory`（account、userId、channel，帖子为空）。

排序键为 `(at DESC, id DESC)`，`at` 取入库时间 `created_at`。游标编码最后一条的 `(at, id)`；两表各查 `limit+1` 条再归并截断，因此新条目只会出现在首页顶部，向前翻页不重复不遗漏。响应附带 `pending` 计数。新增迁移索引 `messages(account_id, created_at)`。

待处理 = 未过期的 draft、approved、带复核标记的 queued（重写中）、平台时间未超过 `maxAgeHours` 的 failed、全部 unknown 消息，以及 `outbox` 中 `unknown` 的帖子。过期条目没有可执行操作，因此不计入，避免数字永远清不掉。

条目“详情”复用现有 `GET /api/messages/:id`（调用元数据与出站）和 `GET /api/tasks/runs/:id`，前端改为可读排版，不再输出原始 JSON。接口沿用管理鉴权；正文只在本接口与既有消息详情接口返回，日志和计费仍不保存正文。

*备选*：给 `/api/messages` 加正文字段。被否决：它不含帖子，游标是 rowid，无法与出站表归并。

### 3. 实时刷新

在现有 SSE `send()` 中增加 `event: feed`，载荷为 `{ latest, pending }`，`latest` 是当前账号 `messages` 与帖子出站的最大 `updated_at`。前端动态页在 `latest` 变化时重取第一页并按 `id` 合并：已存在条目只更新状态区域，正在编辑的草稿节点（输入框有焦点或内容与原文不同）保持不动；新条目插到顶部。其他页面只用 `pending` 更新导航数字。

### 4. 草稿状态机

| 当前状态 | 操作 | 结果 |
|---|---|---|
| draft | 批准（text, revision） | approved，`draft.text` 替换为批准文字，记录 `edited`、`approvedAt` |
| approved | 取消（revision） | draft，保留批准文字 |
| approved | 主循环取走 | sending → confirmed／failed／unknown（现有语义） |
| approved | 主循环发现已过期 | skipped，`error='超时未发送'` |
| draft | 重写（revision） | queued，`draft.review=true`，`draft.previous` 保存原草稿 |
| queued（review） | 主循环生成回复 | draft，保留 `review=true` |
| queued（review） | 主循环生成跳过 | draft，恢复 `previous`，记录 `regenNote`（跳过原因） |

接口：`POST /api/messages/:id/approve {text, revision}`、`/cancel`、`/regenerate {revision}`。批准与重写用条件更新 `UPDATE … WHERE id=? AND account_id=? AND status='draft' AND updated_at=?`；取消只以 `status='approved'` 为条件、不校验修订号，因为主循环写入等待原因时也会更新 `updated_at`。影响行数为 0 时返回 409 并附当前状态。批准时校验非空、`text.length ≤ 4000`、公开回复 `publicLengthOK`、未过期。转换只写数据库，不占用 `busy`，因此主循环运行中也能立即响应。每次操作 `store.log('draft-approve'|'draft-cancel'|'draft-regenerate', {id, channel, result})`，不含正文。

批准或重写后调用新增的 `workflow.wake()`：处于 running 且空闲时把下一轮提前到约 1 秒后，否则不做事。

*备选一*：批准接口直接调用发送并等待结果。被否决：需要抢 `busy`，主循环运行时只能报错让用户重试，且会出现第二条发送路径。
*备选二*：重写接口直接调用模型。被否决：需要浏览器读取上下文，同样与 `busy` 冲突；放回队列可完整复用生成管线、语义判定与计费。

### 5. 主循环发送已批准草稿

把 `tick()` 中单条消息的“生成”和“发送”两段抽成 `Workflow` 私有方法，自动路径与批准路径共用：

- `generateDraft(event, ctx)`：上下文 → 记忆召回 → 人设组装与语义判定 → 生成 → `parseDraft` → 长度校验，阶段记录与计费关联不变。
- `sendDraft(event, text, handle, roundId)`：可靠时间与平台 ID 校验 → 发送前身份复核 → `outbox.prepare/begin` → `transport.send` → `settle` → 更新消息状态、记录角色经历、拒绝退避、写 `processed` 日志。

`tick()` 在 `reconcile()` 之后、采集之前新增一步“发送已批准草稿”：逐条用条件更新 `approved → sending` 取走消息（与取消互斥），依次检查过期、通道退避、本小时额度、同通道待回查。因额度、退避或待回查无法发送时，条件恢复为 approved 并在 `draft.waitReason` 写入原因（quota、cooldown、unknown-pending），供动态页显示；不受运行模式影响。处理完已批准草稿再进入原有采集与队列流程；`pending()` 调整为带复核标记的消息优先。带复核标记的消息生成后一律停在 draft，即使 `mode='auto'`。

若该消息已有 `prepared` 状态的出站行且正文不同（极少见：自动模式提交前中断），新增 `outbox.retext(id, text)`，只允许修改 `prepared` 行；其他状态拒绝批准。

### 6. 模型库

`settings.json` 新增 `modelLibrary` 段，保留 `model` 段作为“使用中模型”的物化结果：

```text
modelLibrary: {
  version: 1,
  providers: [{
    key,            // 目录服务商为其 id；自定义接口为 custom-<短 id>
    provider,       // 目录 id 或 'custom'
    name, baseUrl, api?,
    fetchedAt?, fetchError?,
    models: [{ id, source: 'discovered'|'catalog'|'manual', missing?,
               params?: { reasoningLevel, maxTokens, timeoutMs },
               custom?: { contextWindow, reasoning },
               lastTest?: { ok, at, latencyMs?, error? } }]
  }],
  active: { default: { key, modelId } }   // 预留按用途扩展
}
```

- 模型目录信息（上下文、价格、推理档位）在读取时从 Pi 目录与服务商预设联查，不写入设置文件，避免目录更新后数据过期。
- 每次切换使用中模型，或修改使用中模型所在服务商的连接、该模型参数时，用 `mergePanelSettings('model', …)` 重写 `model` 段。`mergePanel()`、生成器、OpenCode 会话路由、Key 读取都不改动；旧版本回退后仍读 `model`，忽略 `modelLibrary`。
- Key 槽位保持 `provider@host`。两个自定义接口在同一主机时共用一个 Key，属于已知限制。
- 测试结果写入对应模型的 `lastTest`；测试使用中模型时继续写 `runtime['model:lastTest']`，保持首页和 CLI 兼容。
- 接口：`GET /api/model` 增加 `library`（含各服务商状态、Key 掩码、联查后的模型信息）；`POST /api/model/library` 添加服务商（保存 Key 后同步执行一次拉取，超时 25 秒，失败写入 `fetchError` 但仍保存服务商）；`PUT /api/model/library/:key` 修改名称、地址、协议、Key（主机变化时清空待用 Key 并要求重填）；`POST /api/model/library/:key/refresh`；`DELETE /api/model/library/:key`（使用中则 409）；`PUT /api/model/library/:key/models/:id`（参数、自定义参数、手动添加）；`POST /api/model/library/:key/models/:id/test`；`PUT /api/model/active {key, modelId, revision}`。修改沿用 `modelLibrary` 段自己的修订号，冲突返回 409。原 `PUT /api/model` 保留给 CLI：写入后同步登记到库并设为使用中。
- 刷新列表：拉取结果覆盖 `source='discovered'` 的条目；已测试、编辑过或使用中的模型若未返回则保留并标 `missing`；目录服务商拉取失败时列表回退为目录模型（`source='catalog'`）。
- 迁移：首次读取时若无 `modelLibrary` 而有 `model`，生成一个服务商（自定义接口为 `custom-legacy`）及一个模型条目，`params` 取自原配置，`lastTest` 取自 `runtime['model:lastTest']`（服务商与模型一致时），设为使用中；不改动 `model` 段与 Key 文件。迁移写回需带修订号，并发保存冲突时重试读取。
- 界面：两栏布局参照 ZCode（`zai-org/ZCode` 的 `packages/ui/src/settings/ModelProviderSection.tsx` 与 `model-provider-section/`）：左栏服务商列表带状态圆点和“使用中”标记，顶部“添加服务商”打开选择器（目录按国内／海外分组并可搜索，另有“自定义端点”）；右栏依次为标题行（名称、更多菜单：重命名／删除）、连接（Base URL、协议、Key）、模型列表（搜索框、刷新列表、手动添加 ID，每行测试／编辑／设为使用中）。编辑使用弹层。窄屏时左栏收为顶部选择器。只借鉴布局与交互，不复制代码。

*备选*：每个服务商只存手工添加的模型（ZCode 原做法）。被否决：用户要求添加后自动拉取、只需选择。

### 7. 设置页结构

`views/settings.js` 作为外壳，分区依次为：运行模式（标题行内切换）、模型、定时任务、发送限制、记忆策略，以及“排查问题”组下的浏览器接管、运行日志。每个分区是 `<details>`，标题行显示摘要，展开状态写入 `localStorage`（读写包 try/catch，失败时全部收起）。各分区的表单与请求从现有视图拆出复用：运行设置与日志、阶段、队列来自 `program.js`；任务计划与历史来自 `tasks.js`；记忆策略来自 `memory.js`；接管来自 `browser.js`。“消息与回执”删除。离页保护合并所有分区的未保存状态。

定时任务表：一行一个任务，列为名称、开关、时间或间隔、下次执行、更多（立即执行、查看历史）。主循环行只编辑间隔，不显示开关；备份行可编辑；健康检查只读。统一“保存”按顺序逐个 `PUT /api/tasks/:id` 并链式传递修订号，某行失败时停止并标出已保存与失败的行。

### 8. 人设、记忆、计费

- 人设页三个标签共享同一 `mount` 内的状态；切换标签只隐藏面板，未保存的人设与日程编辑保留。
- 记忆页读取 hash 参数直接选中用户；若当前用户有未保存修改，复用已有的“保留编辑／放弃并切换”确认。筛选为搜索框 + 渠道分段按钮，工作账号输入收入“更多筛选”。
- 计费页把“调用流水”放进默认收起的 `<details>`，展开时才请求第一页。

### 8.1 计费页 ZCode 样式

布局参照 ZCode（`zai-org/ZCode` 的 `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`、`UsageHeatmap.tsx`、`AppUsageDailyModelTrendChart.tsx`、`AppUsageModelUsagePieChart.tsx`、`usageStatsUiParts.tsx` 与 `docs/ui/settings-usage-stats.md`），自上而下：

1. **汇总条**：一个圆角面板内横排五项，竖线分隔，数值在上、标签在下居中；窄屏改为纵向。五项为累计 token、累计可估算费用（旁注未定价／未知次数）、单日 token 峰值、近 7 日缓存读取占比、近 7 日平均每次回复费用（只统计 `purpose='reply'` 且已定价的调用）。
2. **活动热力图**：最近 52 个自然周 × 7 天，首行周日，列宽 `minmax(0,1fr)` 等分不滚动；每日／每周／累计三种 pill 切换；月份标签锚定在每月 1 日所在列，最多显示 12 个；颜色按 token 分五档。每周与累计视图悬停高亮整列。格子可键盘聚焦，提示框两行：日期或周范围；token、调用数、可估算费用。
3. **范围切换**：近 7 日／近 30 日 pill；“更多筛选”内保留原自选开始与结束日期和用途筛选，选择后汇总条以外的区块使用自选范围。
4. **按模型每日趋势**：连续补齐日期；最多五个模型各一条折线，其余合并为“其他模型”；Y 轴上限取所显示折线的单点峰值；token／费用切换，费用视图中未定价模型以虚线图例标注“未定价”而不画 0 线。
5. **用量占比**：环形图，按模型／按用途切换，超过六个分区合并为“其他”；右侧明细为色块、名称、百分比、token、费用或“未定价”；“表格”按钮切换为等价表格。
6. **调用流水**：沿用默认收起的 `<details>`。
7. **刷新**按钮位于页尾。

数字格式：`Intl.NumberFormat('zh-CN',{notation:'compact'})` 输出“万／亿”，摘要中数字与单位之间加空格；数字用等宽字体，单位用弱化色。

**数据接口**：现有 `GET /api/billing/summary` 已返回 `daily`、`models`、`purposes`，但为把范围内所有行读入内存后汇总。新增 `GET /api/billing/activity?weeks=52`，返回按北京日期分组的 `{date, calls, totalTokens, costUSD, unpriced, unknown}`，以及汇总条所需的累计与近 7 日指标；`summary` 增加 `dailyModels`（日期×模型）与 `cache: {read, input, ratio|null}`。分组在 SQL 中完成：北京日期用 `date((started_at + 28800000)/1000, 'unixepoch')`；旧 `usage` 表按同一口径并入，模型记为“历史用量”。缓存读取占比 = `cacheRead / (input + cacheRead)`，只统计返回了 usage 的调用，全部缺失时为 `null`。

**图表实现**：在 `public/js/charts/` 新增内联 SVG 小组件（热力图、折线、环形图），原生 ES 模块，不引入 Recharts 或 CDN 依赖，与“不引入框架或构建步骤”的目标一致。配色以 CSS 变量定义浅色与深色两套，分类色最多六个加“其他”灰色；所有图形有 `role="img"` 与文字摘要。

*备选*：引入轻量图表库。需要额外依赖与离线打包，面板只需三种简单图形，被否决。

*备选*：热力图按费用着色。未定价调用无法着色且会误导为空，改为按 token 着色、费用只在提示框显示。

### 9. 提示文字规则

新增两类样式：`.badge-billing`（按钮内“计费”小标记，`title` 与 `aria-describedby` 提供说明）与 `.note-send`（真实发送提示，紧贴发送按钮）。删除字段下的常驻说明，必要说明改为字段标签旁的悬停提示；空状态与错误状态保留。

## Risks / Trade-offs

- [新增一个会真实发送的入口] → 只改变“谁触发”，发送仍走同一 `sendDraft`；服务器用假 transport 覆盖暂停、额度、退避、待回查、账号变化、过期、取消竞态；真实平台验收需用户授权，与七页提案 10.4 同一证据等级。
- [取消与发送竞态] → 两者都以 `status='approved'` 为条件更新，只有一方成功；取消失败时返回当前状态。
- [批准后最多等一轮才发送] → `wake()` 在空闲时提前下一轮；界面显示“等待发送”和等待原因，而不是假装已发送。
- [重写放回队列后被普通队列挤占] → 复核消息在 `pending()` 中优先。
- [模型库与 `model` 段不一致] → 只通过一个写函数同时更新两段；启动时校验 `model` 与 `active` 指向一致，不一致时以 `model` 为准修正 `active` 并写日志。
- [拉取到数百个模型] → 只存 ID 与少量字段，列表前端搜索与分批渲染。
- [两个进行中提案修改同一能力] → 规格依赖七页提案先归档；实施基于当前已部署代码，不等待其归档。
- [工作树有未提交改动] → 实施前在服务器隔离目录同步当前工作树，不重置、不覆盖本机未提交文件。
- [旧版本不认识 approved 状态] → 回退脚本先把 approved 改回 draft 并清除 `review` 标记；`modelLibrary` 对旧版本无影响。

## Migration Plan

1. 在服务器隔离目录按现有 `dev/seven-*.sh` 方式同步当前工作树，确认 0.1.16 回归通过后再开始改动。
2. 数据迁移：新增 `messages(account_id, created_at)` 索引（带版本迁移，可重复执行）；`modelLibrary` 在首次读取时生成。消息状态是自由文本，不需要改表结构。
3. 以 0.1.17 走现有发布流程：发布前备份数据库与 `/data/panel`；生产保持 paused 发布，发布后在 paused 下完成五页界面验收，不发送消息。
4. 回退：`deploy/rollback.sh` 增加一步 `UPDATE messages SET status='draft' WHERE status='approved'`，并去掉 `draft.review`；恢复旧镜像即可，设置文件无需改动。
5. 真实平台验收（批准发送一条回复与一条私信）只在用户明确授权后执行。

## Open Questions

- SSE `feed` 事件沿用 5 秒推送周期是否足够；如实际使用觉得慢，可改为写入后立即推送，不影响接口与任务划分。
