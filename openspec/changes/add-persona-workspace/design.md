# 人设工作区、多人设与正常流程试聊设计

## 背景

本提案有三块：统一设计、人设库、正常流程试聊。三块都落在人设页上，并且有先后依赖：先有统一外壳和组件，再在人设页的人设、日程、试聊三种模式里分别使用。设置页和动态页由后续提案迁移，届时直接复用本提案的外壳与组件，不再重新设计。

管理员确认的版式见 [design-mockup.html](design-mockup.html)。这是可以直接在浏览器打开的交互草图，能点的部分包括：

- 三种模式切换；左右栏收起，刷新后保持；
- 860px 以下的抽屉和浮层；
- 新建菜单和“⋯”菜单；
- 预设只读页、动态提醒页和回放视图；
- 过去日期只读；
- 先攒几条再回；点选轮次后右栏三个标签切换。

草图中的数字和文案只是示例，规则以规格为准。

决定来源分两类。下文没有特别标注的，是管理员在讨论中确认的；标注“（实施者决定）”或“（规划时决定）”的，由规划者或实施者决定，管理员可以在审阅时推翻。

2026-10-28 实施确认：管理员选择公开消息保留各自的平台会话 ID、不跨会话合并，并明确一个试聊会话模拟一个用户。试聊会话标识与平台线程 ID 分开，跨轮用户记忆按试聊用户及渠道保持。

## 1. 统一设计

### 1.1 视觉变量

- 在 `public/style.css` 新增一组带 `--ws-` 前缀的变量，浅色写在 `:root`，深色写在 `@media (prefers-color-scheme: dark)`，与现有面板的主题切换方式一致。现有变量和页面暂不改动，避免影响尚未迁移的四页。
- 取值参考草图：
  - 浅色：底色 `#fff`，侧栏 `#f9fafb`，选中底 `#ebeef2`，悬停为半透明深蓝灰；
  - 文字分四级：`#0f1115`、`#61666b`、`#81858c`、`#adb2b8`；
  - 细边框为黑色 8%–12% 透明度；用户气泡 `#edf3fe`，强调色 `#4176e6`；
  - 卡片底 `#f5f7fa`，圆角 8／12／16／20px；
  - 深色版取对应的深灰阶。
- 字体沿用面板现有字体栈，不加载网络字体。
- 不使用 DeepSeek 或 DeepSeek Harness 的标志、名称、Montserrat 品牌字和官方插图。DeepSeek Harness 的品牌规范禁止在项目中使用其名称，也禁止引起官方背书的误解。

### 1.2 外壳组件 `public/js/shell.js`

- 提供 `mountWorkspace(root, {page, left, main, right?})`：
  - 生成两栏或三栏网格和共用的 44px 页头行；
  - 返回左、主、右三个容器及各自的页头容器，以及 `setRight(visible)`、`collapse(side, bool)`。
- 收起状态存在 `localStorage` 的 `ws:<page>:left`／`ws:<page>:right` 键中，所有读写都包在 try/catch 里；读不到时按展开处理。
- 宽度不超过 860px 时：
  - 左栏变为抽屉，默认关闭，选中条目后自动关闭；
  - 右栏变为浮层，打开时把焦点移入，Esc 关闭并把焦点还给触发它的元素。
- 收起按钮用 `aria-expanded` 和 `aria-controls`，名称为“收起左栏”“展开右栏”等。
- 页面挂载工作区时，给 `body` 加 `workspace` 类：`main` 去掉 1180px 最大宽度和内边距，高度取视口减去顶栏。离开该页面时移除这个类。本提案中只有人设页使用工作区，后续设置页和动态页改版复用同一机制。
- 主区页头的内容由页面自行替换（例如设置页按设置项更换标题和按钮），外壳只提供容器。
- 组件函数和外壳放在同一模块，仍用现有 `dom.js` 的 `h()`，包括 `sideItem`、`segmented`、`badge`、`chip`、`composer`、`turn` 等，不引入框架和构建步骤。

### 1.3 设计规范文档

新增 `docs/设计规范.md`，写明以下内容，供设置页和动态页提案直接引用：

- 变量表和组件清单；
- 版式规则：左栏加主区固定；右栏只用于查看某一项的详情；页头放什么；收起与窄屏行为；
- 状态样式。

## 2. 人设库

### 2.1 数据结构

面板设置新增 `personaLibrary` 分区，写入时整体替换，与 `modelLibrary` 的做法相同：

```text
personaLibrary = {
  version: 1,
  activeId: string,
  items: [{
    id, name, revision, createdAt, updatedAt,
    origin: {kind:'blank'|'preset'|'copy'|'migrated', presetId?, presetVersion?, fromId?},
    persona: {sections, triggers}            // 沿用 validatePersona
  }]                                          // 最多 20 项
}
```

- 面板设置的 `persona` 分区继续存在，始终等于使用中人设的内容，作为镜像。`PersonaService.get()`、日程生成、早晚安帖、回复生成仍读取 `persona`，所以这些调用方不需要改。
- 只有镜像内容变化时 `revisions.persona` 才加一，即保存使用中人设或切换使用中人设的时候。这样现有“下一轮生效”和回放修订冲突的语义保持不变。
- 任何一次人设库写入都让 `revisions.personaLibrary` 加一；每一项另有自己的 `revision`，用于该项的保存冲突检查。
- 新增 `commitPersonaLibrary(next, {expectedLibraryRevision?, itemId?, expectedItemRevision?})`：在一次 `writePanelSettings` 中同时写 `personaLibrary` 和 `persona` 镜像，沿用现有的临时文件加重命名写法，保证原子性。

### 2.2 虚拟库与迁移

- `personaLibrary` 不存在时，系统按现有规则从 `PersonaService.get()` 得出一个虚拟库：一项 `{id:'current', name:'当前人设', origin:{kind:'migrated'}, revision: revisions.persona ?? 0}`，并设为使用中。读取虚拟库不写文件。
- 第一次写人设库时，系统把虚拟库落盘，再执行这次写入。这样升级不会改动面板设置，从未保存过人设的生产仍走通用默认人设，没有变化。
- 回退到旧版本时，旧版本只认 `persona` 镜像，也就是回退前的使用中人设。

### 2.3 接口

所有接口沿用现有的管理鉴权、来源检查和控制请求标记，请求体上限 128 KiB：

| 接口 | 行为 |
| --- | --- |
| `GET /api/personas` | 返回 `activeId`、`libraryRevision`，以及各项的摘要（id、名称、修订号、更新时间、来源、字符数）；预设目录仍由 `GET /api/persona/presets` 提供 |
| `GET /api/personas/:id` | 返回单项全文和固定规则 |
| `POST /api/personas` | `{from:'blank'|'preset'|'copy', presetId?, sourceId?, name?}`；新建项不处于使用中 |
| `PUT /api/personas/:id` | `{revision, name?, persona?}`；修订不符时返回 409 |
| `POST /api/personas/:id/activate` | `{libraryRevision}`；切换使用中并更新镜像 |
| `DELETE /api/personas/:id` | `{revision}`；目标是使用中人设时返回 409 |
| `GET/PUT /api/persona` | 保留兼容：读取或保存使用中那一项 |

- 写操作记录运行日志：`persona-save`、`persona-activate`、`persona-delete`、`persona-create`。日志只写 id、名称和修订号，不写正文。
- 设为使用中时如果该项来自角色预设，返回 `disclosure` 提示数据，供页面显示账号披露提醒。

### 2.4 日程记录生成所用人设

- `daily_revisions` 已经保存 `config_revision`，但没有保存人设 id 和名称。
- 生成或编辑日程时，在业务库已有的 `runtime` 键值表里写入 `daily-persona:<账号>:<日期>:<修订>` → `{id,name,revision}`。这样不新增数据库迁移。
- `daily_revisions` 本身没有清理逻辑，所以这些记录自己清理：每次写入时删除日期早于三十天前的 `daily-persona:` 键。
- 读取时有这条记录就显示人设名称，没有就显示“未记录”。

## 3. 共用回复流程

### 3.1 抽出共用函数

- 新增 `src/reply-pipeline.ts`。把 `Workflow.generateDraft` 里组装上下文、召回记忆、取近期回复样本、组装提示词（含语义判定）、记录生成快照、生成、解析、规整和校验的步骤，抽成 `generateReply(sources, event, options)`。
- 所有外部依赖都通过 `sources` 传入：
  - 对话上下文：`conversation(event)`；
  - 记忆：`memory(event)`；
  - 近期回复：`recentReplies(event)`；
  - 当天日程文本：`dailyState`；
  - 人设服务与人设内容；
  - 字数能力：`posting`；
  - 生成器与会话 id：`generator`、`sessionId`；
  - 快照写入：`snapshot`；
  - 调用元数据：`metadata(step)`；
  - 中止信号：`signal`。
- `Workflow.generateDraft` 改为用生产来源调用它。生成快照（`captureGenerationSnapshot`）在原有的人设修订号之外，追加记录所用人设在人设库中的 id 和名称，供动态页改版显示“由哪个人设生成”；只是 JSON 字段，不改表。`PersonaService.assemble` 内的语义判定调用接受调用方传入的用途和来源，生产仍传 `semantic-trigger`。
- **一致性要求**：抽取前后，生产路径对同一组夹具组装出的系统层与消息层文本必须完全相同，调用次数和元数据也相同。用快照测试锁定（见第 8 节）。试聊不得自行复制或改写这些步骤。

### 3.2 分级的豁免参数

- `ReplyTriage.refreshQueued`、`pending`、`queuedEligibility` 当前用 `maxAgeHours` 过滤超时消息。新增显式选项 `{ignoreAge:true}` 供试聊使用，不用极大数值冒充豁免。
- 额度、冷却期、每轮条数和渠道等待由 `Workflow.channelWaitReason` 判断，不在分级内部。试聊不调用它。

## 4. 试聊服务

### 4.1 存储

- 目录为 `DATA_DIR/chat-test/`，内有独立的 `workflow.sqlite`。由于 `Store` 按数据库所在目录放置 `forget-ledger.json`，`MemoryService` 按同一目录放置 `memory-mutations.json`，独立目录天然带有独立账本，不会碰到生产账本。
- 试聊服务第一次被使用时，才在该库上实例化独立的 `Store`、`MemoryService`、`ReplyTriage`（使用与生产相同的分级设置函数）和试聊专用表：
  - `chat_test_users(id, name, handle, color, created_at, updated_at, last_active_at)`；
  - `chat_test_turns(id, user_id, status, channel, persona_json{id,name,revision,deleted?}, message_ids_json, result_json, diagnostics_json, segments_json, call_ids_json, started_at, finished_at, error)`；
  - `chat_test_seq`，用于生成公开消息的数字 id。
- 试聊库内所有记录的账号固定为 `chat_test`。`Store.ingest` 会对账号做 handle 格式校验，不合格时静默拒绝入库，所以必须用合法的 handle 格式；试聊库与生产库分开，不会与真实账号冲突。
- 测试用户与生产中的 X 用户一样有两个身份：公开身份 `x:<固定模拟标识>`，私信身份 `dm:<测试私信会话 id>`（公开模拟标识与私信会话 id 在新建测试用户时随机生成并固定，不复用显示 handle；编辑 handle 不改变用户身份与记忆）。记忆、冷却和整理进度按身份分开，这与生产一致：生产中同一个人的公开和私信记忆也不互通。
- 业务库备份（`deploy/maintenance-helper.py` 只备份 `app/workflow.sqlite`）不包含试聊库。试聊日志写入试聊库自己的 `logs` 表，不进入生产排查日志。
- 每次处理后按生产的保留天数清理试聊库中的旧消息，测试用户本身保留到管理员删除为止。
- 试聊库打不开或损坏时，试聊接口返回 503，页面显示错误；生产启动和运行不受影响。

### 4.2 事件构造

- 每条测试消息构造为一个 `Event`，字段形状与生产采集结果一致：
  - 公开：`platformId` 为递增的纯数字串，`id` 为 `x:<platformId>`，`userId` 为公开身份，`conversationId` 与生产相同取这条消息自己的平台 id；
  - 私信：`platformId` 为 `ct-<uuid>`，`userId` 为私信身份，`conversationId` 为测试私信会话 id；
  - `timestamp` 取当前时间，`timestampReliable:true`；`accountId:'chat_test'`。
- 公开消息在发送时经测试库的 `triage.ingest` 入库，与生产走同一套分级、批量命中和冷却判定。
- 私信模拟生产采集：生产每轮只把一个会话里最后一条入站消息做成事件，前面的消息只出现在会话上文里。因此“先攒几条再回”时，攒下的私信先作为会话记录保存，处理时只把最后一条经 `triage.ingest` 入库，之前的几条作为上文。立即处理时每条私信就是最后一条。

### 4.3 来源划分

原则是：**账号层面的内容只读生产，用户层面的内容只在试聊库。**

| 来源 | 试聊取值 |
| --- | --- |
| 人设 | 人设库中选定项在处理开始时的快照 |
| 模型、参数、提示词提醒、分级设置、字数能力 | 生产当前设置（只读） |
| 当天日程 | `DailyStateService.describe(当前账号)` 的当天内容，只读，绝不调用 `ensure`；没有时用“暂无当日日程” |
| 角色经历 | 只读生产 `recallRoleExperiences(当前账号)`。生产回复确认后写入的是互动类经历，召回本来就不包含这一类，所以试聊照生产调用 `recordExperience` 写入试聊库，但不参与召回 |
| 近期回复样本 | 生产当前账号的近期公开回复，加上试聊库中该测试用户的回复，按时间合并，上限与生产相同 |
| 记忆（长期、近期往来） | 试聊库 `MemoryService.context(身份, channel, 'chat_test')`，公开和私信身份分开 |
| 对话上下文 | 试聊库中该测试用户同一渠道的往来，按 `transport.context` 的返回结构组装，条数上限与生产相同（实施者核对结构） |
| 生成快照 | 写入试聊轮次记录，不写生产的回放快照 |
| 人设服务实例 | 试聊使用绑定试聊库的 `PersonaService` 实例：语义判定失败时 `assemble` 会写日志，必须写进试聊库，不能写进生产日志 |
| 模型会话 id | `chat-test-<userId>-<channel>`，与生产会话完全分开 |

当前账号指 `store.get('activeAccount')`。值为空时，依赖账号的来源按空处理，字数按普通账号规则校验，并通过状态接口告诉页面显示提示。

### 4.4 一轮处理

1. 校验测试用户存在、所选人设存在（已删除返回 409）、并发名额足够：每个测试用户一轮，全局两轮（规划时决定）。
2. 在测试库中执行 `refreshQueued(..., {ignoreAge:true})`，只取该测试用户的待处理消息，忽略额度和时效。公开消息仍调用生产的 `triage.merge`，仅合并相同平台会话 ID 的消息；每条模拟公开消息保留自身平台 ID 作为会话 ID，因此先攒的公开消息逐条处理，不跨会话合并。私信按第 4.2 节，只有最后一条是本轮事件。
3. 判定结果为过滤、冷却或跳过档时，直接得出本轮结果，不调用模型。
4. 调用 `generateReply`：试聊来源，调用元数据用途为 `chat-test`，来源为 `chat-test:reply` 或 `chat-test:semantic-trigger`，交互 id 为本轮 id。
5. 处理结果分三种：
   - 回复且通过校验：消息记为 `confirmed`，写入合成回执 `{status:'confirmed', reason:'试聊视为已发出'}`，并在测试库 `recordExperience`；
   - 回复但未通过校验：记为 `draft` 并保存校验结果，不算已发出；
   - 模型选择跳过：调用 `triage.recordSkip`，记为 `skipped`。
6. 如果 `memory.due('chat_test', 5)` 包含该身份，就执行 `summarize`。`MemoryService.summarize` 目前把用途写死为 `memory-summary`，需要新增用途参数，生产仍传原值；试聊传用途 `chat-test`、来源 `chat-test:memory-summary`。结果作为系统事件写进本轮记录。
7. 保存本轮诊断，包括人设快照、分级、合并、日程时段、命中、提醒、模型、调用 id、token、耗时、校验、格式和召回条目，以及提示词分段。
8. 清理旧数据，更新测试用户的最近活动时间。

- **中止**：每轮有一个 `AbortController`，`POST .../cancel` 触发中止。中止或失败时消息回到 `queued`，轮次记为 `cancelled` 或 `failed`，原因写入记录。重试会产生新的一轮。
- **不经过的环节**：试聊不经过 `channelWaitReason`、运行状态、人工接管、自动／草稿模式、出站准备与提交，也不调用 transport 的任何方法。

### 4.5 接口

所有接口沿用管理鉴权与控制请求标记，请求体上限 64 KiB，响应不包含 Key：

| 接口 | 行为 |
| --- | --- |
| `GET /api/chat-test/status` | 当前账号与是否已确认、使用中人设、使用中模型、并发占用 |
| `GET/POST /api/chat-test/users` | 列出（按最近活动倒序，带累计费用）／新建 `{name, handle?}` |
| `PATCH/DELETE /api/chat-test/users/:id` | 改名、改 handle／删除及全部数据 |
| `POST /api/chat-test/users/:id/reset`、`/clear-cooldown` | 重置／清除冷却 |
| `GET /api/chat-test/users/:id/turns` | 分页读取消息与轮次 |
| `POST /api/chat-test/users/:id/messages` | `{channel, text(1–4000), personaId?, hold}`；`hold:false` 时同步处理并返回本轮 |
| `POST /api/chat-test/users/:id/process` | `{personaId?}` 处理已入队消息 |
| `POST /api/chat-test/users/:id/turns/:turnId/retry`、`/cancel` | 重试／取消 |
| `GET /api/chat-test/users/:id/memory`、`POST .../memory/summarize` | 记忆标签数据／手动整理 |

同步处理的超时与现有试聊相同，为 360 秒。如果生产 Nginx 对长请求的超时不足，实施者改为“提交后轮询轮次状态”，页面行为不变（实施者核对 `deploy/` 中的 Nginx 配置）。

## 5. 前端

### 5.1 模块与路由

- `views/persona.js` 改为工作区入口，按路由分派到 `persona-editor.js`、`persona-daily.js`、`chat-test.js` 三个模式模块。`persona-replay.js` 由人设模式以第二视图挂载，接口不变。原 `persona-presets-panel.js` 的填入和撤销流程删除，建议简介和复制保留在配置页。
- 路由：

  | 地址 | 打开 |
  | --- | --- |
  | `#/persona` | 使用中人设 |
  | `#/persona/p/<id>`、`#/persona/p/<id>/replay` | 某个人设的配置、回放 |
  | `#/persona/preset/<presetId>` | 某个预设（只读） |
  | `#/persona/hints` | 动态提醒 |
  | `#/persona/daily`、`#/persona/daily/<YYYY-MM-DD>` | 今天或某天的日程 |
  | `#/persona/chat`、`#/persona/chat/<userId>` | 试聊 |

  旧地址 `#/persona/persona` 跳到 `#/persona`，`#/persona/preview` 跳到 `#/persona/chat`。
- 左栏页头是“人设／日程／试聊”分段切换，切换时保留各模式最后选中的条目。

### 5.2 人设模式（两栏）

- 左栏有三部分：
  - “我的人设”：使用中的一项带绿点和“使用中”，其余显示更新时间；分组标题旁有新建按钮，可选空白、从预设新建或复制；
  - “内置预设 · 只读模板”；
  - 底部固定的“动态提醒（所有人设共用）”条目（规划时决定：提醒是全局设置，单独成项，避免被误以为属于某个人设）。
- 主区页头：
  - 名称、使用中徽标、修订号、字符数；
  - 未保存标记；
  - “回放对比”“试聊这个人设”“保存”三个按钮；
  - “⋯”菜单：设为使用中、复制、重命名、删除。
- 主区内容：
  - “始终生效”“被问到才用”两组分区，双列卡片，窄屏时变单列；
  - 触发卡列表：开关、名称、关键词或语义、条件摘要，点开编辑；
  - 固定规则和建议简介，默认折叠。
- 预设被选中时，主区只读，页头只有“以此新建”。

### 5.3 日程模式（两栏）

- 左栏：近七天，今天置顶，每项标注生成、已编辑或失败；页头齿轮链接到 `#/settings/tasks`。
- 主区：左侧是时间线，今天高亮当前时段；右侧是三餐、活动、心情三张卡片，窄屏时变单列。
- 页头：生成人设、修订号、费用；今天的日程有“编辑”和“重新生成（计费）”。编辑沿用现有的日程编辑器和修订检查。

### 5.4 试聊模式（三栏）

- 左栏：试聊会话列表，一个会话对应一个独立模拟用户，持续保留该用户的记忆、近期往来与冷却；有新建按钮，以及盾牌图标的悬停说明“测试数据单独存放……”。
- 主区页头：测试用户名称、测试 handle、轮数、本会话累计费用；“⋯”菜单是改名、重置、清除冷却、删除；另有收起右栏按钮。
- 对话流中各类条目的显示：

  | 条目 | 显示方式 |
  | --- | --- |
  | 用户消息 | 右侧气泡，左边标出渠道和时间 |
  | 角色回复 | 无气泡正文，上方一行摘要，下方显示模型、token 和费用 |
  | 跳过、过滤、冷却 | 虚线框，写明原因 |
  | 未通过校验的回复 | 正文加“正常流程不会发出”的说明 |
  | 合并处理 | 在被合并的消息上标注 |
  | 记忆整理 | 居中的系统提示 |

  点击一轮后高亮这一轮，并让右栏显示它的详情。
- 输入框：
  - 人设选择：只列“我的人设”，默认使用中；
  - 渠道选择、“先攒几条再回”开关，开启时出现“让角色回复”按钮；
  - 说明文字：“正常流程 · 模型名 · 不发到 X · 不占额度 · 会计费”；
  - Enter 发送、Shift+Enter 换行（规划时决定）；处理中禁用发送，显示进度和取消按钮。
- 右栏：本轮详情、记忆、提示词三个标签，内容按规格。

### 5.5 计费页

`billing.js` 的用途名称新增 `chat-test: '试聊'`，原有的 `persona-preview` 改名为“人设试聊（旧接口）”。计费页只改这两个名称，版式不变，后续提案再迁移。

### 5.6 回放按人设

现有回放写死了使用中人设：基线“当前已保存人设”取 `persona.get()`，修订校验用 `revisions.persona`，采用候选调用 `PersonaService.save` 写回使用中人设（`src/persona-replay.ts`）。本提案改为以**发起回放的那个人设**为准（规划时决定，沿用“编辑器当前内容对比该人设已保存版本”的原有语义）：

- 候选：该人设编辑器中的当前内容；
- 基线“已保存人设”：该人设在人设库中的已保存版本；“以历史实际回复为基线”的选项不变；
- 修订冲突检查：使用该人设的单项修订号；
- 采用候选：保存到该人设，不改变使用中人设；
- 回放记录在现有 `settings_json` 中记下人设 id 和名称，不改表；回放列表显示人设名称，已删除的人设标注已删除。
- 模型对比沿用原规则：两侧使用同一份已保存人设，这里指发起回放的人设。

## 6. 计量

- 试聊的每次实际请求都写入生产业务库的统一调用流水：
  - `purpose='chat-test'`；
  - `source` 写明是哪一步：`chat-test:reply`、`chat-test:semantic-trigger` 或 `chat-test:memory-summary`；
  - `account_id` 为当前账号，账号未确认时为空；
  - `interaction_id` 为轮次 id，手动整理时为整理事件 id。
- 计费统计本来就该包含真实花费，调用流水因此是试聊唯一写入生产库的数据。
- 测试用户的累计费用，等于该用户所有轮次和整理事件的调用 id 在流水中的合计。

## 7. 失败处理

| 情况 | 行为 |
| --- | --- |
| 人设库文件损坏或校验失败 | 读取返回 500 并写日志，不覆盖文件；生产继续使用 `persona` 镜像 |
| 人设库写入冲突 | 返回 409，页面提示重新读取，保留未保存编辑 |
| 试聊所选人设已删除 | 返回 409，页面要求重新选择 |
| 模型失败、输出不合格 | 本轮记为失败，已落账用量保留，消息回到待处理，可重试 |
| 并发名额不足 | 返回 429，提示稍后再试 |
| 当前账号未确认 | 照常处理，账号层面的来源为空，页面提示 |
| 记忆整理失败 | 写一条失败的系统事件，不影响本轮回复，下次满足条件时再试 |
| 试聊库损坏 | 试聊接口返回 503，生产不受影响；管理员可以在服务器上移走 `chat-test/` 目录后重建 |

## 8. 验证

所有构建、测试和界面验收都在服务器隔离环境执行，不使用生产 profile 和生产数据目录。

- **一致性**：用固定夹具（公开和私信，含合并、关键词卡、语义卡、近期往来、角色经历）比较抽取前后生产路径组装的提示词文本、调用次数和元数据，必须完全相同。试聊路径在相同来源下组装的文本，也必须与生产路径相同。
- **隔离**：
  - 在临时数据目录中做一组试聊，涵盖回复、跳过、过滤、合并、整理、重置和删除；
  - 断言生产库的 `messages`、记忆相关表、`triage_*`、`outbox`、回放快照、`logs` 和两份生产账本都不变；`llm_calls` 只新增 `chat-test` 用途的记录；
  - 断言 transport 没有被调用。
- **豁免**：在额度已满、暂停、人工接管、草稿模式、未收束出站和平台拒绝退避的状态下，试聊仍能处理，而且这些状态和计数都不变。
- **人设库**：虚拟库读取不写文件；首次写入落盘；`persona` 镜像与修订号的规则；切换、删除限制、名称唯一、数量上限、修订冲突；回退后旧版本读取镜像（用一份旧版本的读取函数夹具验证）。
- **日程**：记录生成所用人设；旧记录显示“未记录”；过去日期只读。
- **界面**：
  - 1440、1280、860、375 四种宽度，浅色和深色；
  - 三种模式；左右栏收起和刷新后恢复；抽屉和浮层；未保存保护；
  - 旧地址跳转；
  - 截图存入证据目录，不出现整体横向滚动。
  - 现有的五页、预设、文风、补齐等界面验收脚本中涉及人设页的步骤改写到新结构，其余页面的步骤保持通过。
- **批量验收工具**：`POST /api/persona/preview` 的现有测试保持通过；用 mock 模式跑一遍 `persona-preset-eval` 的端到端流程。
- **真实模型**：自动测试一律使用 mock 模型。用真实模型做试聊效果验收需要管理员另行授权调用次数，结果由管理员审阅，不作为构建通过的条件。

## 9. 兼容与回退

- 生产数据库结构不变。新增的只有：`runtime` 表里的日程人设记录、`llm_calls` 表里的新用途值、独立的 `chat-test/` 目录。
- 旧版本忽略 `personaLibrary`，读取 `persona` 镜像，也就是回退前的使用中人设；`chat-test/` 目录被忽略，可以保留或删除；`chat-test` 用途在旧计费页按原始字符串显示。
- 前端回退后恢复旧人设页，试聊数据仍保留在 `chat-test/` 目录中，再次升级后可以继续使用。

## 10. 与其他提案的关系

- `add-reply-hours`、`add-private-daily-limit` 尚未实施。它们实施时，新加的时段和额度检查只能放在生产路径（`Workflow` 和出站）里，不得放进 `reply-pipeline` 或分级的公共函数，以免影响试聊。两份提案的设计在实施时需要补充这一点。
- 设置页和动态页的改版提案复用 `shell.js`、`--ws-` 变量和 `docs/设计规范.md`。届时再迁移计费页的版式，并统一顶栏。
- 本提案的前端改动只涉及人设页。动态、记忆、设置、计费四页保持现状，两种版式并存是预期中的过渡状态。

## 11. 留给实施者的决定

- 外壳组件的具体 API 和文件拆分，只要满足第 1 节的行为。
- `transport.context` 返回结构的核对与试聊上下文组装的细节，只要满足第 4.3 节“结构与条数一致”。
- 同步处理和轮询二选一，取决于 Nginx 超时。
- 测试用户头像颜色的生成方式，以及左栏、徽标等的精确尺寸，以草图为参照。
- 试聊库表的索引和字段细节。
