# 统一设计语言规范（DESIGN.md）

本文档定义「角色互动工作流」前端面板的统一设计语言。所有页面（动态、人设、设置）、工作区外壳、业务组件与交互草图均须遵循本规范。

---

## 1. 设计原则

1. **内容与状态优先**：对话往来正文、运行控制状态与核心指标是界面的视觉焦点；容器描边、底色与辅助控件保持克制，不抢占正文视线。
2. **紧凑高效、层级分明**：桌面端采用铺满视口的三栏/两栏工作区，各栏独立滚动；高频设置与关键摘要首屏直达，低频参数与次要诊断按需展开或置于悬停/右栏。
3. **几何秩序与同心圆角**：所有组件圆角、间距与字号严格收敛至有限阶梯令牌；嵌套容器遵循「内外同心圆角定律」，消除散乱像素值与转角厚薄失调。
4. **语义自明与无障碍**：状态表达必须「色彩 + 文字」成对出现，绝不单靠颜色区分含义；全面支持键盘焦点导航、读屏语义属性与 `prefers-reduced-motion` 动态减弱。
5. **原生轻量、零外部依赖**：采用系统原生无衬线与等宽字体栈，跟随系统浅色/深色主题自动切换，不加载外部网络字体，不使用任何第三方品牌标志或背书素材。

---

## 2. 色彩与主题令牌

所有视觉颜色通过 CSS 自定义属性定义，在 `:root`（浅色）与 `@media (prefers-color-scheme: dark)`（深色）中自动切换，禁止在业务样式中硬编码散乱色值。

### 2.1 表面与背景层级

| 变量令牌 | 浅色值 | 深色值 | 语义与用途 |
| --- | --- | --- | --- |
| `--ws-bg` / `--surface` | `#ffffff` | `#151517` / `#141417` | 主工作区、详情栏、弹窗与输入控件底色 |
| `--ws-side` / `--bg` | `#f9fafb` / `#f6f7f9` | `#1b1b1c` / `#0c0c0e` | 左栏导航背景、传统页面画布底色 |
| `--ws-card` | `#f5f7fa` | `#1f1f21` | 工作区内容卡片、次级分块底色 |
| `--ws-fill` / `--surface-2` | `#f3f4f6` / `#f1f2f4` | `#232326` / `#1c1c20` | 复合输入盒（`.ws-box`）、表头及弱填充底色 |
| `--ws-hover` | `rgba(38, 49, 72, .06)` | `rgba(255, 255, 255, .06)` | 列表项、图标按钮与对话回复悬停态 |
| `--ws-active` | `#ebeef2` | `#2c2c2e` | 侧栏选中项、分段控制器轨道与默认徽标底色 |
| `--ws-bubble` | `#edf3fe` | `#283142` | 对方/用户消息气泡底色 |
| `--ws-mask` | `rgba(15, 17, 21, .24)` | `rgba(0, 0, 0, .50)` | 窄屏抽屉与模态弹窗背景遮罩 |

### 2.2 文本与边界层级

| 变量令牌 | 浅色值 | 深色值 | 语义与用途 |
| --- | --- | --- | --- |
| `--ws-text` / `--text` | `#0f1115` / `#111827` | `#f9fafb` / `#e7e7ea` | 一级正文、标题、主按钮反白基底 |
| `--ws-muted` / `--muted` | `#61666b` / `#6b7280` | `#adb2b8` / `#8b8b94` | 二级文本、字段标签、表头与默认图标 |
| `--ws-faint` / `--faint` | `#81858c` / `#9ca3af` | `#81858c` / `#63636b` | 三级辅助说明、时间戳、空状态与次要摘要 |
| `--ws-caption` | `#adb2b8` | `#61666b` | 四级弱提示、时间线默认节点与禁用辅助 |
| `--ws-border` / `--border` | `rgba(0, 0, 0, .08)` / `#e5e7eb` | `rgba(255, 255, 255, .08)` / `#26262b` | 栏间分割线、卡片外框、表格行分割线 |
| `--ws-border-strong` / `--border-strong` | `rgba(0, 0, 0, .12)` / `#d1d5db` | `rgba(255, 255, 255, .16)` / `#34343a` | 输入框、普通按钮、虚线说明框与聚焦描边 |

### 2.3 语义状态与头像色板

| 变量令牌 | 浅色（前景 / 浅底） | 深色（前景 / 浅底） | 语义与用途 |
| --- | --- | --- | --- |
| `--ws-brand` / `--ws-brand-soft` | `#4176e6` / `#e4edfd` | `#7aaaff` / `#28314a` | 品牌强调、链接、键盘焦点环、处理中状态 |
| `--ws-ok` / `--ws-ok-soft` | `#15803d` / `#e6faed` | `#4ade80` / `#233c2c` | 运行中、使用中、测试通过、健康正常 |
| `--ws-warning` / `--ws-warning-soft` | `#aa6416` / `#fef5e7` | `#fbbf24` / `#27241f` | 暂停/排空、未保存、待回查、需关注告警 |
| `--ws-error` / `--ws-error-soft` | `#dc2626` / `#fef2f2` | `#f87171` / `#3a1d1d` | 发送失败、连接异常、危险删除操作 |
| `--ws-avatar-1` … `-6` | 暖橙、蓝、绿、粉、紫、青浅底深字 | 对应六色深底浅字 | 首字头像稳定散列配色，浅深主题对比度均 $\ge 4.5:1$ |

---

## 3. 圆角体系与同心几何规范

项目中所有组件的圆角统一收敛至 **6 级基础数值阶梯 + 胶囊形/正圆形**。严禁在 CSS 中编写 `5px`、`7px`、`9px`、`14px`、`20px`、`24px` 等未纳入令牌体系的散乱值。

### 3.1 核心几何定律

1. **内外同心圆角定律（Concentric Nesting）**
   当带圆角的子组件嵌套在具有内边距（`padding`）的父容器内部时，内外圆角须满足近似同心关系：
   $$R_{\text{outer}} = R_{\text{inner}} + \text{Padding}$$
   - **分段控制器（`.ws-segmented` / `.segmented` / `.chat-channel`）**：外框 `--r-md (8px)`，内边距 `2px`，内部切换项 `--r-sm (6px)`（$8 - 2 = 6$）。
   - **浮层下拉与操作菜单（`.popover` / `.ws-menu-popover` / `.provider-menu > div`）**：外框 `--r-lg (10px)`，内边距 `4px`，内部菜单项 `--r-sm (6px)`（$10 - 4 = 6$）。
   - **对话与草稿复合输入盒（`.ws-box`）**：外框 `--r-2xl (16px)`，内边距 `10px–14px`，底部工具栏控件采用 `--r-sm (6px)` 至 `--r-md (8px)`，转角弧度与外框同心贴合。
   - **一级卡片嵌套二级块（`.card` / `.ws-card` $\to$ `.subcard` / `.ws-rule-card` / `.table-wrap`）**：一级卡片 `--r-xl (12px)`，内部二级容器 `--r-lg (10px)`，内部表单控件 `--r-md (8px)`。

2. **高度比例匹配定律（Height Proportionality）**
   矩形控件的圆角应随控件高度成比例缩放，保持曲率一致：
   - 高度 $\le 16\text{px}$ 的微角标使用 `--r-xs (4px)`；
   - 高度 $18\text{px}–28\text{px}$ 的紧凑标签、小号按钮、图标按钮使用 `--r-sm (6px)`；
   - 高度 $30\text{px}–38\text{px}$ 的标准按钮、输入框、导航与侧栏列表项统一使用 `--r-md (8px)`。

3. **单侧色条直角定律（Left-Accent Strip）**
   左侧带有 `2px–3px` 实线强调描边的引用块或提示条（`.feed-original`、`.ws-notice.warn`、`.timeline li.current`、`.reply-format-note`），**左上与左下必须保持 `0` 直角**，仅右侧使用圆角（`0 var(--r-sm) var(--r-sm) 0` 或 `0 var(--r-xs) var(--r-xs) 0`），避免粗左描边在圆角处出现月牙形分叉。

### 3.2 圆角令牌与全量组件映射表

| 令牌名称 | 数值 | 适用高度/层级 | 绑定组件与选择器 |
| --- | --- | --- | --- |
| `--r-2xs` | `2px` | $\le 10\text{px}$ 微色块 | 热力图与图表图例色块（`.heat-key`, `.legend-swatch`） |
| `--r-xs` | `4px` | $14\text{px}–16\text{px}$ 微内嵌件 | 按钮内嵌计费标（`.badge-billing`）、SVG 键盘焦点框（`.chart-frame > svg:focus-visible`）、格式提示条右圆角（`.reply-format-note`, `.reply-format-check`）、用户气泡右下指向角 |
| `--r-sm` | `6px` | $18\text{px}–28\text{px}$ 紧凑控件与内嵌项 | 状态与分类徽标（`.chip`, `.ws-badge`, `.ws-chip`, `.ws-status`）、小号按钮（`.btn.small`）、图标按钮（`.ws-icon-button`）、对话行内轻操作按钮（`.ws-reply-actions .ws-button`, `.ws-reply-actions .btn`, `.feed-thread .feed-details-button`）、筛选短签（`.feed-filter`）、分段器内滑块（`.ws-segmented button`, `.segmented .btn`, `.chat-channel label`）、试聊栏内紧凑选择与开关（`.chat-dock select`, `.chat-hold`）、下拉与菜单选项（`.opt`, `.ws-menu-popover button`, `.provider-choice`）、占比高亮行（`.share-row.is-active`）、左色条容器右圆角（`.feed-original`, `.ws-notice.warn`, `.timeline li.current`）、浏览器空态图标框（`.desk-icon`） |
| `--r-md` | `8px` | $30\text{px}–38\text{px}$ 标准控件与列表项 | 标准按钮（`.btn`, `.ws-button`, `.chat-send`）、输入框与选择器（`.input`, `.ws-input`, `.ws-shell .input`, `.select`）、顶栏与侧栏导航条目（`.tabs a`, `.ws-side-item`, `.settings-nav-item`, `.provider-row`, `.feed-conversation`）、分段控制器外框（`.ws-segmented`, `.segmented`, `.chat-channel`）、紧凑提示框与侧栏提醒条（`.callout`, `.feed-attention`, `.feed-pending-imports`）、图表悬浮提示（`.chart-tip`） |
| `--r-lg` | `10px` | 二级嵌套容器与弹出浮层 | 二级卡片与规则卡（`.subcard`, `.ws-rule-card`, `.info`, `.metric`）、可交互选择卡（`.memory-user`, `.radio-card`, `.persona-preset-option`）、表格外框（`.table-wrap`）、下拉与菜单浮层（`.popover`, `.ws-menu-popover`, `.provider-menu > div`）、全局通知与离开确认条（`.notice`, `.confirm`, `.feed-workspace > .confirm`）、虚线说明框（`.ws-turn-note`, `.ws-notice.skip`, `.feed-explanation`）、对话轮次选中热区（`.ws-turn`, `.ws-thread .ws-reply`） |
| `--r-xl` | `12px` | 一级卡片与面板容器 | `--radius` 与 `--ws-radius` 别名；一级内容卡片（`.card`, `.ws-card`）、设置模式卡与指标卡（`.settings-mode-card`, `.settings-metric`）、健康与用量汇总框（`.health-metrics`, `.usage-summary`）、预设保存提示框（`.persona-preset-saved`）、远程桌面容器（`.desk-frame`）、传统消息块（`.chat-message`） |
| `--r-2xl` | `16px` | 模态弹窗、对话气泡与复合输入盒 | 模态对话框（`.modal-card`）、对话与草稿复合输入盒（`.ws-box`）、用户对话气泡（`.ws-bubble`：`16px 16px 4px 16px`） |
| `--r-pill` | `999px` | 独立状态胶囊与悬浮角标 | 顶栏运行状态胶囊（`.pill`）、未读计数角标（`.count-badge`）、动态流底部新消息悬浮胶囊（`.feed-new-messages`） |
| `--r-full` | `50%` | 正圆图形 | 首字头像（`.ws-avatar`, `.feed-avatar`）、状态与时间线圆点（`.ws-dot`, `.status-dot`, `.settings-state-dot`, `.pill::before`, `.logs .e::before`, `.ws-timeline li::before`, `.chat-persona.active::before`, `.chat-working i`） |

---

## 4. 字体、排版与数值规范

### 4.1 字体栈

- **正文与界面字体**：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`
- **代码、事件标识与数值等宽字体**：`ui-monospace, SFMono-Regular, Menlo, monospace`

### 4.2 字号与行高阶梯

| 级别 | 字号 | 字重 | 行高 | 典型场景 |
| --- | --- | --- | --- | --- |
| 指标大字 | `20px–22px` | `650` | `1.2` | 用量汇总（`.usage-stat strong`）、设置指标卡（`.settings-metric > strong`） |
| 弹窗/旧页标题 | `18px–20px` | `600` | `1.4` | `.modal-card h2`, `.page-title` |
| 卡片与分区标题 | `14px` | `600–650` | `1.45` | `.card-h`, `.settings-section-title`, `.subcard > h3` |
| 工作区页头与导航 | `13px` | `600`（标题）/ `400`（条目） | `1.45` | `.ws-header-content h1–h3`, `.ws-heading`, `.ws-side-title`, `.settings-nav-item`, `.btn` |
| 对话与基础正文 | `14px` | `400` | `1.7–1.8`（对话）/ `1.55`（常规） | `.ws-reply-body`, `.ws-bubble`, `.ws-box textarea`, `body` |
| 次要信息与表格 | `12px` | `400–500` | `1.5` | `.small`, `.field`, `.data-table`, `.ws-detail-row`, `.ws-notice` |
| 辅助注释与徽标 | `10.5px–11.5px` | `400–500` | `1.4` | `.ws-side-subtitle`, `.ws-badge`, `.ws-status`, `.ws-stat`, `.chat-caption` |

### 4.3 数值与成对信息对齐

- 凡展示金额、token 数量、耗时、配额与列表时间戳，均须启用 `font-variant-numeric: tabular-nums`。
- 右栏详情中的「名称—数值」成对信息统一使用 `.ws-detail-row`（`grid-template-columns: auto minmax(0, 1fr); align-items: start`），标签不换行，数值右对齐并在自身列内安全断词换行（`overflow-wrap: anywhere`）。

---

## 5. 工作区版式与响应式规范

### 5.1 全局顶栏与三栏外壳

- **全局顶栏（`.topbar`）**：固定于视口顶部，左侧为应用标题与一级页面切换（动态、人设、设置），右侧为连接提示、运行状态胶囊（`.pill`）、接管入口与主启停按钮（`#primary-action`）。
- **工作区外壳（`.ws-shell`）**：挂载时为 `body` 添加 `workspace` 类，高度占满 `100dvh - var(--ws-top-height)`，移除外层最大宽度限制。
  - **左栏（`.ws-left`）**：默认宽 `232px`（动态页 `272px`），背景 `--ws-side`，用于模式切换、分组导航与会话列表。
  - **主区（`.ws-main`）**：自适应剩余宽度（`minmax(0, 1fr)`），顶部固定 `44px` 页头（`.ws-header`），内容区（`.ws-content`）独立滚动，试聊输入栏（`.chat-dock`）固定于主区底部。
  - **右栏（`.ws-right`）**：默认宽 `300px`，仅在需要查看单条回复、轮次或会话详情时开启，可由用户手动收起。
- **收起状态持久化**：左、右栏收起状态分别保存在 `localStorage` 的 `ws:<page>:left` 与 `ws:<page>:right` 中，所有存储读写必须包含 `try/catch` 异常保护。

### 5.2 响应式断点

| 断点 | 布局行为 |
| --- | --- |
| `> 1100px` | 标准桌面三栏/两栏宽度，页头完整显示副标题与全部次要操作 |
| `≤ 1100px` | 左栏收窄至 `208px`（动态 `232px`），右栏收窄至 `270px`（动态 `260px`），隐藏页头 `.ws-secondary` 次要说明 |
| `≤ 860px` | 主区单列占满；左栏转为默认关闭的抽屉，选中条目后自动收起；右栏转为带遮罩（`.ws-mask`）的模态浮层（`role="dialog"`, `aria-modal="true"`），打开时移入焦点，按 `Esc` 或点遮罩关闭并归还触发元素焦点 |
| `≤ 480px / 420px` | 双列网格转为单列，页头与复合输入盒内边距收紧，保证 `375px` 视口下无整页横向滚动（表格仅在 `.table-wrap` 内部横向滚动） |

---

## 6. 核心组件与交互规范

### 6.1 按钮与动作层级

- **主操作按钮（`.btn.primary` / `.ws-button.primary`）**：深底浅字（深色模式下浅底深字），每个页头或表单区域最多放置一个主操作按钮。
- **普通操作按钮（`.btn` / `.ws-button`）**：`--ws-bg` 底色配 `--ws-border-strong` 描边，统一 `--r-md (8px)` 圆角。
- **紧凑/行内轻按钮（`.btn.small` / `.ws-reply-actions .ws-button` / `.feed-details-button`）**：用于表格行、对话操作行与密集工具栏，统一 `--r-sm (6px)` 圆角。
- **图标按钮（`.ws-icon-button`）**：`28px × 28px` 无边框透明底，悬停显示 `--ws-hover`，统一 `--r-sm (6px)` 圆角，必须提供 `aria-label` 与 `title`。
- **计费操作提示**：凡触发真实模型调用的操作按钮（测试、重写、重新生成、重新整理、计费任务单次执行），按钮内必须附带 `.badge-billing`（「计费」微标签，圆角 `--r-xs (4px)`）。

### 6.2 对话流与复合输入盒

- **对话流容器（`.ws-thread`）**：最大宽度 `680px` 居中，对方消息仅展示右对齐气泡（`.ws-bubble`），不重复堆砌渠道与分级元信息；首条、相隔 $\ge 5$ 分钟或跨日时显示居中时间分隔（`.ws-divider`），渠道切换显示带横线分隔（`.ws-divider.line`）。
- **角色回复（`.ws-reply`）**：左列 `30px` 圆形首字头像（`.ws-avatar`），右列为人设名称行（含 `.ws-status` 状态签与触发卡标签）、正文、结果提示（`.ws-notice`）与底部操作行（`.ws-reply-actions`）。统计摘要（`.ws-stat`）默认透明，仅在悬停、键盘聚焦或选中该轮时显现。
- **复合输入盒（`.ws-box`）**：用于试聊底部输入与动态草稿编辑，采用 `--ws-fill` 底色与 `--r-2xl (16px)` 圆角；聚焦时外框显现 `1px solid var(--ws-border-strong)`。内部 `textarea.input` 必须保持透明背景、无边框、`border-radius: 0`、`resize: none` 并随内容自动增高（试聊上限 `220px`，动态草稿上限 `260px`），刷新时复用原 DOM 节点以保护输入焦点与光标位置。

### 6.3 状态反馈与未保存编辑保护

- **异步三态**：所有数据区域必须明确区分「加载中」「空状态」「读取失败（附重试按钮）」，禁止用陈旧缓存冒充最新成功结果。
- **浮动通知（`.notice`）**：工作区模式下固定于页头下方右侧，`pointer-events: none` 不阻挡页头与输入框点击。
- **未保存编辑保护**：编辑人设、动态提醒、日程或设置表单时，切换条目、切换模式或离开页面前必须检测脏状态，弹出 `.confirm` 确认条提供「保留编辑」与「放弃并离开」，并配合浏览器 `beforeunload` 防止误关丢失。
