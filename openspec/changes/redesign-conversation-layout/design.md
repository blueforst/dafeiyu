# 试聊与动态对话排版改版设计

## 背景与决定来源

管理员 2026-10-29 先在两种试聊草图中选择 B“对话优先”，并确认了以下排版：

- 用户消息只留气泡；渠道切换用分隔线；超过五分钟显示时间。
- 回复带头像、人设名和卡片标签；统计数据只在悬停或选中时出现；结果类提示始终可见。
- 输入区为灰色大圆角框，控件在框内；处理中发送变停止；说明文字移到框下。

随后要求动态页也按同一思路优化，并确认了动态页草图：

- 对方消息只留气泡；状态放在人设名旁，“已发送”最安静、其余上色并写原因。
- 草稿改为圆角编辑框，按钮在框内；其他操作进入下方操作行。
- 左栏头像修正为可读配色，状态改为彩色文字。

两份草图合在 [design-mockup.html](design-mockup.html)，其中的数字和文案只是示例。

下文没有标注的，是管理员确认的内容；标注“（规划时决定）”的由规划者补充，管理员审阅时可以推翻。

目标：

- 两页的对话流读起来是同一个产品：一屏看清更多往来，正文是视觉重点。
- 诊断和出站数据不丢失，只是换位置：常驻的放右栏，按需的放悬停摘要。
- 共用部分只写一份，后续页面可以直接复用。

非目标：

- 不改处理流程、接口、存储、计费、筛选、分页、实时刷新和并发规则。
- 不改草稿批准、重写、取消、重新入队的规则和请求。
- 不改状态名称（规划时决定）。草图中的“草稿待审”只是示例，实现沿用现有“草稿”，避免影响筛选、计数和测试。
- 不改人设模式、日程模式和设置页的外观。

## 1. 共用部分

### 1.1 变量（`public/style.css`）

在 `:root` 和深色媒体查询中新增：

- `--ws-fill`：圆角输入框底色，浅色 `#f3f4f6`，深色 `#232326`。
- `--ws-avatar-1-bg`／`--ws-avatar-1-fg` 到 `--ws-avatar-6-bg`／`--ws-avatar-6-fg`：六组头像配色。浅色取草图的暖橙、蓝、绿、粉、紫、青浅底配深字，深色取对应深底配浅字。实施时逐组核对对比度不低于 4.5:1。

### 1.2 共用样式类

都写在 `style.css` 中，带 `ws-` 前缀：

| 类 | 作用 |
| --- | --- |
| `.ws-thread` | 对话列，最大宽度 680px 居中，纵向排列，左右内边距 22px |
| `.ws-divider`、`.ws-divider.line` | 居中小字时间；带横线的渠道切换 |
| `.ws-thread .ws-turn-user` | 右对齐气泡，最大宽度 78%，去掉通用 `.ws-turn` 的内边距和选中底色 |
| `.ws-msg-mark` | 气泡下方的小字标记（作为上文、合并处理、待处理、已过滤、采集时间） |
| `.ws-reply` | 角色一侧：两列网格，左列 30px 头像；选中时 `--ws-hover` 浅底、12px 圆角 |
| `.ws-avatar`、`.ws-avatar-1` 到 `-6` | 圆形头像；对话流中 30px，左栏 32px |
| `.ws-reply-name` | 人设名行，可放状态、卡片标签和“合并 N 条” |
| `.ws-status` 及 `.quiet`、`.blue`、`.warn`、`.bad` | 状态胶囊；`quiet` 无底色并带小勾 |
| `.ws-notice.skip`、`.ws-notice.warn`、`.ws-notice.bad`、`.ws-why` | 虚线框“没有回复”；告警色条；错误；正文下方的原因小字 |
| `.ws-reply-actions` | 操作行：“详情”胶囊、图标按钮、小胶囊按钮、链接 |
| `.ws-stat` | 摘要：默认 `opacity:0`；`.ws-reply:hover`、`:focus-within`、`.selected` 时为 1；`@media (hover:none)` 下只在 `.selected` 时为 1；`prefers-reduced-motion` 下不加过渡 |
| `.ws-box` | 灰色圆角框，试聊输入区和动态草稿共用：底色 `--ws-fill`，内含无边框透明 `textarea` 和底部按钮行 `.ws-box-bar` |
| `.ws-detail-row` | 右栏名称—数值行：`grid-template-columns:auto minmax(0,1fr)`，`align-items:start`，数值右对齐、`overflow-wrap:anywhere` |

通用 `.ws-turn.selected{background:var(--ws-brand-soft)}` 保留给未迁移的旧用法；`.ws-thread` 内的选中样式以 `.ws-reply.selected` 为准。

### 1.3 共用组件（`public/js/shell.js`）

新增导出，现有导出的参数和输出不变：

- `avatar(name, seed)`：返回 `span.ws-avatar.ws-avatar-N`。文字取 `Array.from(String(name||'').trim())[0]`，为空时显示“?”。`N` 由 `seed||name` 的字符串散列（逐码点乘 31 累加，取无符号）对 6 取余加 1 得到，同一标识颜色稳定（规划时决定）。设置 `aria-hidden="true"`，名称由旁边的文字提供。
- `divider(text, {line=false})`：返回 `div.ws-divider`，`role="separator"`，带横线时加 `line`。
- `timeDivider(prevAt, at)`：没有上一条、相隔不少于 5 分钟或日期不同时，返回分隔文字，否则返回 `null`。格式为“今天 HH:mm”“昨天 HH:mm”“MM/DD HH:mm”，时区与 `dom.js` 的 `fmtDateTime` 相同。
- `reply({role, avatar, name, status, tags, body, notices, actions, stats, selected, onselect, ...attrs})`：返回 `article.ws-turn.ws-turn-${role}.ws-reply`，`role` 默认 `assistant`，可为 `note`。保留 `ws-turn-*` 类名作为测试钩子。外层 `tabindex=0`、`role=button`，点击或按 Enter、空格时调用 `onselect`，按钮、链接、输入框内的点击除外。`stats` 放在操作行末尾，套 `.ws-stat`。
- `detailRow(label, value)`：返回 `div.ws-detail-row`。
- `sideItem`：`icon` 改为用 `avatar(icon, attrs.iconSeed ?? title)` 渲染，新增可选参数 `iconSeed`，不传时行为兼容。

## 2. 试聊（`public/js/views/chat-test.js`）

### 2.1 对话区

`render()` 改为输出 `.ws-thread`。遍历时记住上一条用户消息的时间和渠道：

- 对话第一个分隔为“今天 21:04 · 公开”。
- 渠道变化时显示带横线的“21:15 · 切换到私信”；与时间分隔同时出现时合并成这一条。
- 其余由 `timeDivider()` 决定。

消息时间取 `timestamp`、`createdAt`，都没有时取所在轮次的 `startedAt`。

用户消息用 `turn({role:'user'})`，不传 `summary`。气泡下方的标记：

- `context`：作为上文；
- `merged`：合并处理；
- 未进入任何轮次的排队消息：待处理，私信补“回复时只取最后一条”；
- 所在轮次 `failed` 或 `cancelled`：待处理。

所在轮次已完成时，不按消息自身的 `queued`／`held` 显示“待处理”。点击气泡仍选中所在轮次。

每一轮的角色一侧用 `reply()`：

- **头像与名称**：`avatar(persona.name, persona.id)`，名称按原逻辑加“（已删除）”“（库暂不可读）”。读取了卡片时，每张一个“读取 卡名”标签，超过三张显示前三张和“等 N 张”（规划时决定）；私信合并多条时加“合并 N 条”。
- **正文**：`draft.action==='reply'` 时显示，行高 1.8。
- **结果提示**，顺序固定：
  1. 跳过、过滤、冷却、取消：虚线框“没有回复：原因”，原因取值顺序与现在相同；
  2. 字数校验未通过或 `notSent`：“正常流程不会发出：原因”；
  3. 可能提及私信内容；
  4. `formatNotice()`；
  5. 报错。
- **处理中**：显示“正在按正常流程处理…”和三个渐隐圆点，减少动态效果时不动画。
- **操作行**：
  - “详情”：选中本轮，窄屏时打开浮层，并记录触发元素以便归还焦点；
  - “复制”：图标按钮，`aria-label="复制回复"`，只在有正文时出现。用 `navigator.clipboard.writeText`，成功 `notice('已复制')`，失败 `notice('无法复制，请手动选择文字','error')`；
  - “重试（会再次计费）”：只在 `failed`、`cancelled` 时出现，因为后端只允许这两种状态重试；
  - 摘要：分级、召回条数、合并条数（大于 1 时）、耗时（秒，一位小数）、`feesText()`。

记忆整理结果用 `divider()` 样式的居中胶囊。“加载更早轮次”改为对话列顶部居中的普通按钮。

### 2.2 输入区

结构：`form.chat-dock` 包含两部分：

- `div.ws-box`：里面是 `textarea#chat-test-message` 和 `div.ws-box-bar`；
- 框下方的说明行 `div.chat-caption`。

挂在 `ws.mainPane` 末尾，不再调用 `composer()`；`composer()` 保留导出。

- **框**：圆角 24px，最大宽度与对话列一致，`textarea` 获得焦点时加 1px `--ws-border-strong` 描边。
- **输入框**：`resize:none`，最少一行，随内容长高，最多 8 行（约 200px）后在框内滚动。`input` 事件里先把 `height` 设为 `auto` 再取 `scrollHeight`；发送成功清空后恢复一行。占位文字为“以「测试用户名」的身份发消息…”。保留 `maxlength=4000` 和现有回车逻辑（`!e.shiftKey && !e.isComposing`）。
- **底部一行**，从左到右：
  1. 人设：保留原生 `select#chat-test-persona`，样式改为胶囊。当前选中的是使用中人设时，左侧显示绿色圆点；选项文字沿用“名称 · 使用中”（规划时决定，原生下拉对键盘、读屏和测试都最稳）。
  2. 渠道：`div#chat-test-channel[role=radiogroup]`，内含 `name=chat-test-channel` 的两个单选（`public`、`private`），外观为“公开｜私信”分段胶囊，默认公开。新增 `channelValue()`，替换原来读 `channel.value` 的地方。
  3. 先攒几条：`label` 包住保留的 `input#chat-test-hold[type=checkbox]`。复选框视觉隐藏但保留尺寸，开启时胶囊变为品牌浅色。
  4. `#chat-test-process`：“让角色回复 · N 条”，公开为“回复下一条 · N 条”，显示条件不变。
  5. 弹性空白。
  6. `#chat-test-send`：32px 圆形，向上箭头图标。`aria-label`、`title` 为“发送”，开启先攒几条时为“加入待处理”。
  7. `#chat-test-cancel`：与发送按钮同位置的停止图标，`aria-label="停止本轮"`。`setBusy(true)` 时隐藏发送、显示停止，结束后恢复。
- **说明行**：居中小字，内容是现在的 `info` 加 `progress`。
- **窄屏**：860px 以下框内边距减小，按钮行允许换行，人设胶囊最大宽度 50% 并截断；420px 以下说明行可换行。

### 2.3 右栏

`detailRow()` 改用 `shell.js` 的共用版本，卡片内边距 14px、卡片间距 10px。“关联调用”中的成对信息也用它。

## 3. 动态（`public/js/views/feed.js`、`feed-workspace.css`）

### 3.1 主区

`.feed-thread` 加上 `.ws-thread`。`make()` 与 `renderEntry()` 的数据来源和更新方式不变，只换呈现：

- **日期分隔**：现有“2026年10月29日”按天分隔，改为 `timeDivider()`，`reconcile()` 中按排序后的相邻条目计算显隐，替代现在的 `dateKey` 比较。
- **对方消息**：`turn({role:'user'})` 只放原话，去掉 `feed-user-meta` 行。
  - 渠道已在主区页头注明。
  - 分级、分级原因和时间进入该条摘要；时间不可靠时摘要写“采集时间”。
  - 被过滤、合并、冷却的消息，气泡下方写对应标记。
  - 角色帖会话没有对方消息，与现在相同。
- **角色一侧**：用 `reply()` 替换现在的 `turn({role:'assistant'})`。
  - 外层保留 `feed-item` 结构和 `data-id`，以便现有选择、实时刷新和测试继续定位。
  - **头像与名称**：人设取 `item.persona ?? item.draft?.meta?.persona`，现有返回已带草稿原样，不改接口。没有记录时，名称和头像用当前账号 handle（来自 `getStatus()`），种子为账号 id（规划时决定）。角色帖同样处理。
  - **状态**：名称旁显示 `stateLabel(item)`。`confirmed` 用 `quiet` 加小勾；`draft`、`queued`、`generating`、`approved`、`sending`、`prepared` 用 `blue`；`unknown` 用 `warn`；`failed`、`rejected` 用 `bad`；过滤、跳过、合并、冷却、错过、停用、取消、中止用普通灰底。
  - **原因**：`queued`、`approved` 的等待原因（`WAIT` 映射）、`unknown` 的回查说明、`error`、`draft.regenNote`、`draft.reason`，按现有 `note` 的取值，以 `.ws-why` 显示在正文下方；跳过类用虚线框“没有回复：原因”。早晚安任务名作为名称行的小标签。
  - **正文**：非草稿时显示正文。
  - **草稿**：正文位置换成 `div.ws-box`，内含 `textarea.feed-draft` 和 `ws-box-bar`。
    - 按钮行：左侧小字“批准后将真实发送到 X；暂停期间等待恢复”，右侧“重写”（带现有 `billingBadge()`）和主按钮“发送”。
    - 输入框自动长高，规则与试聊相同，最多 10 行。
    - `expired` 时禁用。
    - 后台状态变化的保护提示（“后台状态已变化，当前编辑仍保留…”）显示在框上方。
    - 格式标记和可能提及私信内容的提示显示在框上方。
  - **操作行**：
    - “详情”（替代现在的“查看详情”）；
    - 规则允许时“重新入队”“取消发送”，用小胶囊按钮；
    - “在 X 上查看 ↗”“查看原文 ↗”用链接样式，链接校验沿用 `link()`；
    - 摘要：分级、分级原因、提交或确认时间、回执状态，沿用现有 `responseMeta` 的取值。
  - 选中仍由 `select()` 控制，只是选中样式改为 `.ws-reply.selected`，对方气泡不再随之变色。
- **其他视图**：“有新消息 ↓”“加载更早往来”、需要关注视图和补录视图不变。

### 3.2 左栏

- 会话头像改用 `avatar()`。
  - 公开身份取 handle 去掉 `@` 后的首字符；
  - 私信会话显示“私”；
  - 角色帖显示“帖”。
  - 种子用会话 key。未读计数徽标保持在头像右上角。
- 状态改为彩色文字：需要处理的（待回查、发送失败、草稿、等待发送、等待处理）用品牌色或告警色，其余用次要色，后接“ · 摘要”。
- 不改排序、筛选、分页和计数。

### 3.3 右栏

内容和顺序不变（规划时决定）。现有“名称：数值”形式的单行信息（所用人设、分级、状态等）改用 `detailRow()`，分块继续用现有 `subcard`。提示词与密钥仍不显示。

## 4. 数据流、状态与副作用

- 两页都不新增或修改接口。试聊所需字段在 `/api/chat-test/users/:id/turns` 中都有；动态所需字段在 `/api/feed/conversations` 及其 `items` 返回中都有，人设取自已返回的草稿。
- 新增前端状态只有试聊渠道单选的取值。
- 剪贴板写入是唯一新增的浏览器副作用，失败不影响其他功能。
- 动态草稿的编辑保护（`editorGuard`、后台变化保留编辑）、实时刷新时保留输入焦点和光标的逻辑不变；改的只是 `textarea` 的外框。

## 5. 兼容与测试钩子

- 试聊保留的 id：`chat-test-message`、`chat-test-send`、`chat-test-process`、`chat-test-cancel`、`chat-test-hold`、`chat-test-persona`、`chat-test-create`。
- 动态保留的类和属性：`feed-item`、`data-id`、`feed-draft`、`feed-thread`、`feed-conversations`、`feed-new-messages`。“查看详情”改名为“详情”时同步修改测试。
- 两页保留 `ws-turn-assistant`、`ws-turn-note`、`ws-turn-system`、`ws-turn-user`。
- `#chat-test-channel` 从 `select` 改为单选组，测试中的 `selectOption('private')` 改为点击 `#chat-test-channel input[value=private]`。
- 断言旧摘要行文字的地方，改为断言悬停摘要或右栏，保留原业务含义。
- 动态页 `.feed-item .ws-turn`、`.feed-item .ws-bubble` 的旧覆盖规则与新共用样式冲突的部分删除，以共用样式为准。

## 6. 与其他提案的衔接

- `convert-trigger-cards-to-skills` 正在实施，它在 `chat-test.js` 和动态右栏中加了“读取：卡名／未读取触发卡”和“工具调用 N／20”。本提案的卡片标签读取同一字段，右栏保留工具调用行。
  - 实施开始时，如果那份提案的前端改动仍未提交，先与管理员确认基线，不覆盖其改动。
  - `chat-test` 的“本轮诊断”以它修改后的文字为基础。
- `activity-feed` 的两项修改以 `redesign-feed-workspace` 的文字为基础，`panel-design-system` 的新增在 `add-persona-workspace` 之上。归档顺序在这三份之后。

## 7. 验证

- 服务器隔离环境 `/srv/role-workflow-proposals` 运行 `dev/workspace-ui-test.sh` 的全部十八个套件，用模拟接口，不调用真实模型。
- 新增排版断言：
  - **共用**（写入 `workspace-shell-ui-acceptance`）：
    - `avatar()` 对同一种子输出同一组配色，表情开头的名称输出完整字符；
    - 六组配色在两种主题下对比度不低于 4.5:1；
    - `timeDivider()` 的首条、两分钟、八分钟、跨日四种情况；
    - `.ws-stat` 在悬停、聚焦、选中和 `hover:none` 下的可见性；
    - `detailRow` 名称与数值顶端相差不超过 1px。
  - **试聊**（写入 `persona-workspace-ui-acceptance`）：
    - 已完成轮次无“待处理”；
    - 渠道分隔只在切换处出现；
    - 对话中无模型名和 token；
    - 选中只给回复加底色；
    - 输入二十行后高度不超过 220px 且 `resize:none`；
    - 处理中发送隐藏、停止可见；
    - 复制成功与被拒的提示。
  - **动态**（写入 `feed-workspace-ui-acceptance`）：
    - 对方气泡上下无渠道和分级；
    - `confirmed` 状态无底色；
    - `approved` 显示等待原因和“取消发送”；
    - `unknown` 为告警色且无发送和重新入队；
    - 草稿框内有“重写”“发送”，十行草稿时框长高且无拖拽角，改字后批准请求携带修改后的文字；
    - 无人设记录时显示账号 handle；
    - 左栏头像文字对比度达标。
- 375px 下两页 `document.documentElement.scrollWidth<=innerWidth`。
- 截图：两页各取 1440、1280、860、375 宽，浅色和深色共十六张，存入本轮证据目录，与草图对照。

## 8. 失败处理与回退

- 共用样式加载失败或某个类缺失时，页面仍可用：结构是语义化的 `article`、`form`、按钮和链接。
- 回退：还原 `shell.js`、`style.css`、`chat-test.js`、`feed.js`、`feed-workspace.css` 和测试文件。没有数据或接口迁移，旧版前端可以直接替换回去。
