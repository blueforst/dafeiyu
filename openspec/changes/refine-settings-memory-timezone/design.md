# 设置页细节、跨渠道记忆与时区中立技术设计

## Context

现状按本机源码 `f29715f` 与 2026-10-29 生产只读数据核对：

- **左栏颜色**：`public/style.css` 的 `.ws-shell a{color:var(--ws-brand)}` 优先级为 0,1,1，高于 `.settings-nav-item{color:inherit}` 和 `.ws-side-item{color:var(--ws-text)}`（都是 0,1,0）。设置项是 `<a>`，所以显示品牌蓝；全局 `a:hover{text-decoration:underline}` 又给它加了悬停下划线。共享组件 `sideItem` 传入 `href` 时同样渲染为 `<a>`，有同样的问题。
- **左栏摘要**：`settings.js` 的 `refreshSummaries` 打开设置页时发出七个请求（运行、任务、分级、记忆策略、计费、健康、任务历史），每项右侧显示最长 116px 的截断文字。
- **健康页**：`settings/health.js` 每项指标一张 `.settings-metric` 卡（22px 状态字），四列网格。生产 `/api/health` 返回 20 项，其中 `collection-public`、`collection-private`、`collection-failures` 不在 `METRIC_TITLE` 中，都显示为“运行观察”。三项 `compliance-*` 指标与“账号检查”区重复。日报是逐行 `<details>`。
- **身份**：公开事件 `userId='x:'+handle.toLowerCase()`（`public-post.ts`、`public-target.ts`）；私信事件 `userId='dm:'+conversationId`，`handle:''`（`chat-dom.ts:299`、`browser.ts:177`），一对一会话 ID 形如 `数字-数字`。全库没有身份关联数据。
- **召回**：`MemoryService.context` 中，私信读取 `['public','private']` 两个渠道的条目，但查询条件都是同一个 `user_id`，私信身份下没有公开条目，所以实际上只读到私信。近期往来同理。
- **试聊**：`ChatTestService.identity()` 公开返回 `x:ct_<12位>`，私信返回 `dm:ct_<32位>`。生产试聊库里，同一测试用户公开说“你好呀”后私信问“你还记得我吗?”，回复是不记得。
- **时间**：`reply-prompt.ts` 末尾“现在”段为 `2026-10-29 周四 03:53（深夜，北京时间）`，当日日程段带 `currentSlot`；`reply-hints.ts:66` 的迟到提醒写着“并按现在的时段问候”。生产试聊记录：北京时间 03:53 公开收到“你好呀”，回复“这个点还没睡，是来陪我熬深夜的吗”。

## Goals / Non-Goals

**Goals**

- 设置左栏与另外两页一致，只在需要处理时用圆点提示。
- 健康页一屏看全指标，日报不展开就能读到数字。
- 同一个人的公开和私信身份可以可靠关联；关联后双向召回，私信内容在公开回复中只作背景并有确定性兜底。
- 回复不再按北京时间假设对方的作息。

**Non-Goals**

- 不合并或迁移已有记忆，不改记忆整理的阈值与范围（仍按身份、按渠道整理）。
- 不按同名、显示名或文本相似度猜测关联。
- 不改健康指标判定、告警、日报内容，不改设置项含义与接口。
- 不改动态页的会话分组（仍按身份分会话）、回复时段、早晚安帖、额度与出站规则。
- 不在验收前启用私信对方 handle 的生产读取结果之外的任何自动行为；本提案不恢复业务、不发送消息。

## Decisions

### 1. 设置左栏

- `settings.js` 改用 `sideItem({title,href,selected,meta})` 渲染设置项，不再使用 `.settings-nav-item` 与 `.settings-nav-summary`。`meta` 只在需要处理时放一个圆点：

  ```js
  h('span',{class:'ws-dot '+level,role:'img','aria-label':text,title:text})
  ```

- 共享样式修复（`public/style.css`）：
  - `.ws-shell .ws-side-item{color:var(--ws-text)}`（0,2,0，高于 `.ws-shell a`）；
  - `.ws-shell a.ws-side-item:hover{text-decoration:none}`；
  - 新增 `.ws-dot{width:7px;height:7px;border-radius:50%}`，`.attention` 用 `--ws-warning`，`.error` 用 `--ws-error`。
  - 这样所有以链接实现的左栏条目都不再显示品牌蓝。
- 圆点条件：

  | 设置项 | 显示圆点 | 来源 |
  | --- | --- | --- |
  | 运行与发送 | `status.configError` 非空（异常色） | 状态推送 |
  | 模型 | 尚未配置（需关注色） | 状态推送 |
  | 浏览器接管 | 人工接管中（需关注色）；需要登录（异常色） | 状态推送 |
  | 健康与日报 | 需关注或异常，说明含非正常项数 | `/api/health` |
  | 任务执行历史 | 最近一次执行失败（异常色） | `/api/tasks/runs?limit=1` |
  | 其余各项 | 不显示 | — |

- `refreshSummaries` 只保留健康与任务历史两个请求，其余五个删除，打开设置页的请求数减少。子页面通过 `ctx.setSummary(value,level)` 上报状态的约定保留：`level` 为 `attention` 或 `error` 时显示圆点，`value` 作为说明；否则隐藏圆点。
- 运行模式与状态继续显示在“运行与发送”的页头和顶部运行控制中。

### 2. 健康与日报（`settings/health.js`）

- 分组与名称：

  | 组 | 指标标识 |
  | --- | --- |
  | 运行 | `send-stall` 发送进度、`reply-stall` 回复进度、`reply-hours` 回复时段、`round-failures` 轮次运行、`watchdog-failure` 调度看门狗 |
  | 采集 | `collection-public` 公开采集、`collection-private` 私信采集、`collection-failures` 采集告警 |
  | 发送 | `cooldown-public` 公开发送退避、`cooldown-private` 私信发送退避、`automation-public` 公开自动化拦截、`automation-private` 私信自动化拦截 |
  | 浏览器 | `browser-human` 人工处理、`browser-recovery` 浏览器恢复、`browser-resource-pressure` 浏览器资源 |
  | 账号 | `account-restricted` 账号状态、`compliance-disclosure` 简介披露、`compliance-label` 自动化账号标签、`compliance-quality` 通知质量过滤 |
  | 基础设施 | `backup-failure` 数据库备份、`certificate-expiry` 证书有效期 |
  | 其他 | 未登记的标识，名称用 `m.name`，没有时显示标识本身 |

- 版式：
  - 顶部状态行：圆点、`正常`／`需关注 N 项`／`异常 N 项`、采样时间；“刷新”留在页头。
  - 每组一个 `.health-group`：左侧 88px 组名，右侧行网格 `repeat(auto-fill,minmax(320px,1fr))`。
  - 行高约 34px，内容为圆点、名称、状态、单行省略的说明，`title` 放完整说明。
  - 非正常行 `grid-column:1/-1`，说明不省略，排在组内最前。
  - 按生产 20 项估算，状态行加六组约 600px，1440×900 内一屏可见。
- 账号组：在组尾显示 `compliance.checkedAt` 和“检查计划”链接。接口没有 `compliance-*` 指标但有 `compliance` 对象时，用现有的 `checks` 推导逻辑生成三行，保证不缺项。删除独立的“账号检查”区。
- 日报表格：

  | 列 | 字段 |
  | --- | --- |
  | 日期 | `date` |
  | 调用 | `model.calls` |
  | token | `model.totalTokens` |
  | 费用 | `money(model.costUSD)`，有未定价调用时附“未定价 N” |
  | 公开 | `received/replied/failed`，悬停显示跳过和待回查 |
  | 私信 | 同上 |
  | 响应 | 中位数／P90，单位秒 |
  | 告警 | `alerts`，悬停显示拦截、浏览器恢复和暂停分钟 |

  表格放在 `.table-wrap` 中，窄屏只在表格内横向滚动。
- 告警历史：`<details>` 默认收起，内含表格（状态、摘要、开始、恢复或最近一次）。健康与披露配置表单不变。
- 宽度不超过 860px 时组名改到组上方，行网格单列。

### 3. 身份关联数据（schema 14）

```sql
CREATE TABLE identity_links(
  account_id TEXT NOT NULL, private_user_id TEXT NOT NULL, public_user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('chat-test','platform','admin')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,private_user_id));
CREATE INDEX identity_links_public ON identity_links(account_id,public_user_id);
CREATE TABLE identity_link_blocks(
  account_id TEXT NOT NULL, private_user_id TEXT NOT NULL, public_user_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(account_id,private_user_id,public_user_id));
```

- 迁移 `applyMigration(store.db,14,'公开与私信身份关联',…)`，生产库和试聊库都执行。
- 新增 `src/identity-links.ts`：
  - `link(account,privateId,publicId,source)`：`privateId` 须匹配 `^(dm|conversation):`，`publicId` 须匹配 `^x:[a-z0-9_]{1,15}$`。规则如下：
    - `platform` 来源：有阻止记录时不写；已关联到另一个公开身份时不改写，写日志 `identity-link-conflict`。
    - `admin` 来源：可覆盖已有关联，并删除该对的阻止记录。
    - `chat-test` 来源：只在试聊库使用。
  - `unlink(account,privateId)`：删除关联；管理员解除时写入阻止记录。
  - `publicOf(account,privateId)`、`privatesOf(account,publicId)`：召回和界面读取。
- 关联与解除都调用 `invalidateReplayMemory`，作废两侧的回放记忆快照。
- 遗忘与删除账本不变。遗忘不删除关联，召回时跳过被遗忘的身份。
- 关联表在 `workflow.sqlite` 中，随现有备份一起保存。

### 4. 召回（`MemoryService.context`）

- **私信回复**（身份 `dm:X`）：
  - `pub = publicOf(dm:X)`，被遗忘时视为无；
  - 条目：`items(dm:X,'private') ∪ items(pub,'public')`，按更新时间倒序，共用现有 30 条／8000 字符预算；
  - 近期往来：`(user_id=dm:X) OR (user_id=pub AND channel='public')`，沿用 `recentDays`、`recentCount`，每条保留 `channel`。
- **公开回复**（身份 `x:Y`）：
  - 条目与近期往来与现在相同，只取 `x:Y` 的公开数据；
  - 新增 `privateBackground`：`privatesOf(x:Y)` 中未被遗忘的会话，取其 `private` 条目，去掉来源原文和来源 ID，只保留 `type` 与 `text`；单独预算 10 条／2000 字符，按更新时间倒序；
  - 私信原文、私信近期往来、私信来源详情一律不进入。
- 返回值增加 `privateBackground`（只在公开回复且非空时出现）和 `linked`（关联对象与来源，用于界面和本轮详情）。
- 记忆整理仍按身份和渠道各自进行，输入只含本身份的消息。
- `detail()` 增加 `links` 与只读的 `linkedItems`，供记忆页和动态页右栏显示，并标注渠道与来源。

### 5. 提示词（`reply-prompt.ts`、`reply-hints.ts`）

- `FIXED_SYSTEM_RULES` 末尾追加两句，属于稳定前缀，版本切换时缓存只失效一次：
  - 时区：“你所在的时间是北京时间。X 上的人分布在各个时区，你不知道对方那边几点；除非对方在本次消息或近期往来里提到自己的时间或作息，不要按你的时间推断对方是早上、晚上还是深夜，也不用‘这么晚还不睡’‘早安’‘晚安’这类替对方假设时段的说法；可以偶尔顺口说你自己这边的时间或日程。”
  - 私信背景：“标为‘私信中得知’的内容只作背景：公开回复里不提及、复述、暗示或确认，也不说你们私信过。”
- “现在”段改为 `你这边：2026-10-29 周四 03:53（深夜，北京时间）。对方的当地时间未知。`
- 当日日程段保留 `currentSlot`，增加 `note:'这是你自己的日程和时段'`，同一时段内仍保持稳定。
- 新增段 `{kind:'private-background',title:'私信中得知（只作背景）',role:'user',stable:false}`，放在“关于对方的记忆”之后，只在公开回复且 `privateBackground` 非空时出现。
- 迟到提醒改为 `对方约 N 小时前发来消息；自然地为迟到致歉一次，不要按你这边的时间推断对方现在的时段。`
- `REPLY_PROMPT_VERSION='reply-context-v5'`。回放快照记录版本，新旧版本的样本可以区分。

### 6. 私信内容重合检查

- `privateOverlap(text,backgroundTexts,min=8)`（`src/reply-style.ts` 或新文件）：
  - 规范化：NFKC、小写、去掉空白和 Unicode 标点与符号；
  - 用回复文本的 8 字滑动窗口与背景文本的 8 字片段集合求交，有命中时向两侧扩展，得到最长片段；
  - 返回 `{fragment}` 或 `null`。
- `reply-pipeline.ts` 在 `parseDraft` 之后：公开渠道且本轮 `privateBackground` 非空时，计算并写入 `draft.privacy={overlap:fragment}`。
- `workflow.ts` 在现有 `validation.allowed` 检查处，将 `draft.privacy?.overlap` 视为 `{allowed:false,code:'private-overlap',reason:'可能提及私信内容'}`，记录保持草稿。管理员审核后批准发送时不再拦截，但保留标注。
- 动态页草稿显示“可能提及私信内容”标签和重合片段。试聊按“正常流程不会发出：可能提及私信内容”显示，不计入已发出。

### 7. 私信对方 handle 读取（`chat-dom.ts`、`browser.ts`）

- 只在会话 ID 匹配 `DIRECT` 或页面明确标为一对一时读取。
  - 旧版私信：读取会话头部的个人主页链接与 `@handle` 文本。
  - 原生 X Chat：读取会话头部开放的 shadow root 中的对应元素。
- 只接受一个去重后、与工作账号自己不同、符合 handle 格式的结果，写入事件的 `peerHandle`。其他情况写诊断 `private-peer-unverified` 或 `private-peer-ambiguous`，不写 `peerHandle`。
- 入库时如有 `peerHandle`，调用 `link(account,event.userId,'x:'+peerHandle.toLowerCase(),'platform')`。
- 读取只读、不点击，不增加导航。两种页面结构都需要真实样本验证。
- 平台来源的关联由常量开关 `PLATFORM_IDENTITY_LINKS` 控制，默认关闭。关闭时只把读到的候选 handle 写入诊断日志，不写关联表；任务 7.2 用真实样本验证通过后，随发布打开。这样在验证前，生产中只有管理员手动关联生效。

### 8. 记忆页与接口

- 接口（写操作沿用 `x-workflow-control` 与同源校验）：
  - `GET /api/memory/links?accountId=&userId=`：返回该身份的关联、来源、时间和阻止状态；
  - `PUT /api/memory/links`：`{accountId,privateUserId,publicHandle}`，以管理员来源关联；
  - `DELETE /api/memory/links`：`{accountId,privateUserId}`，解除并写入阻止记录。
- `GET /api/memory/users` 每行增加 `linkedTo`（对方标识与来源）。
- 记忆页详情增加“身份关联”行：
  - 私信会话：显示已关联的 @handle 和来源，提供“解除关联”；未关联时提供“关联公开身份”，输入 @handle。确认文案说明：私信记忆会在公开回复中作为背景，并有重合检查。
  - 公开身份：列出已关联的私信会话，可逐个解除。
  - 已解除的会话显示“管理员已解除”。
- 列表行显示“已关联”标签。窄屏沿用现有的详情顶部选择器。
- `docs/前端接口.md` 与 `docs/记忆策略.md` 同步更新。

### 9. 试聊

- 新建测试用户时在试聊库写入 `link(chat_test,'dm:'+conversation_id,public_identity,'chat-test')`。服务启动时为已有测试用户补写关联，可重复执行。
- 重置时保留关联；删除用户时删除关联。
- 本轮详情的召回列表显示来源渠道，以及是否用了私信背景。
- 试聊库与生产库互不读取关联。

## Risks / Trade-offs

- **改写后的泄露**：模型可能换个说法透露私信内容，绕过八字重合检查。管理员已接受这一风险。缓解：公开回复只给私信长期条目、条数单独限额，提示词有明确约束，管理员可随时解除关联。重合检查只是兜底，不保证拦截所有泄露。
- **关联错人**：平台读取一旦关联错，私信背景会进入另一个人的公开回复。缓解：只接受一对一会话中的唯一 handle，冲突时不改写，管理员解除后不自动恢复，验收前不在生产启用平台来源。
- **重合误报**：常见短语可能触发误报，后果只是转为草稿，可以接受。
- **左栏信息减少**：模型名、今日费用等不再显示在左栏，管理员已同意，这些信息仍在各自页面。
- **提示词风格变化**：新约束可能让部分人设少了作息梗，需要真实模型抽查。早晚安帖和日程不受影响。
- **并行修改**：`settings.js`、`memory.ts`、`reply-prompt.ts`、`workflow.ts` 也是其他提案的修改点。实施前先核对工作副本，没有未提交的他人改动再开始。

## Migration / Rollback

- schema 14 只新增两张表，不改已有表。回退到 0.1.19.x 时旧代码不认识这两张表，也不会读取，召回自动退回未关联的状态，数据保留。
- 提示词版本由 v4 升到 v5，回退即恢复 v4，不涉及数据。
- 前端只改展示，回退镜像即可恢复。
- 发布沿用现有流程：先在服务器隔离环境构建和测试，取得授权后成对发布 app 与 browser，保持原控制状态。

## Verification

- 服务器单元与集成测试（隔离环境，不用生产 profile）：
  - 身份关联：格式校验、平台冲突、阻止记录、管理员覆盖、解除后召回范围、遗忘跳过、回放快照作废；
  - 召回：私信召回公开条目与公开近期往来；公开只召回私信长期条目，不含私信原文；无关联时范围与现在一致；
  - 提示词：v5 段落顺序、“现在”段文字、时区约束、迟到提醒文案、私信背景段只在公开且非空时出现；
  - 重合检查：正好 8 字、7 字、标点与空白干扰、全角半角、emoji；`private-overlap` 转为草稿，批准后可提交；
  - 试聊：新建即关联、启动补写、重置保留、删除移除；复现“公开你好呀 → 私信你还记得我吗”时私信召回公开往来；
  - DOM：旧版与原生 Chat 夹具覆盖唯一、多个、缺失、自己 handle 四种情况。
- 界面验收：设置左栏浅色、深色与 375px 截图，颜色与人设页、动态页一致，圆点有可读名称；健康页 1440×900 一屏显示 20 项，375px 无整体横向滚动；记忆页关联与解除的完整流程。
- 真实模型抽查（计费调用，需另行授权）：用试聊在北京深夜和早晨各发问候类与普通消息，覆盖大肥鱼和另外两个预设；统计回复中对对方时段的假设次数，并抽查私信背景是否被提及。
- 真实平台验收：取得真实一对一私信样本后，验证对方 handle 读取与平台来源关联；在此之前对应任务保持未完成。
