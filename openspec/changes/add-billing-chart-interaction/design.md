# 计费图表交互技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [llm-usage-billing 规格](specs/llm-usage-billing/spec.md)。以下现状来自 2026-10-28 本机工作副本（提交 `f3fef70`，即生产 0.1.17）：

- **组件形态**：`public/js/charts/usage.js` 导出 `heatmap()`、`trend()`、`share()` 三个函数，每次都整块重建 SVG 并返回 DOM。`views/billing.js` 在切换视图、范围或指标时调用 `set()` 替换。
- **热力图**：364 个 `rect`，每个都有 `tabindex=0`、`aria-label` 和 `<title>`。CSS 只有 `.heat-cell:focus` 描边，以及 `.column-heat .heat-week:hover rect` 整列描边。
- **趋势图**：每个数据点是 `r=2.5` 的 `circle`，带 `tabindex=0` 和 `<title>`；没有日期列的悬停区域。
- **环形图**：每个扇区是带 `stroke-dasharray` 的 `circle`，带 `tabindex=0` 和 `<title>`。右侧明细与扇区没有关联。
- **事件机制**：没有任何指针或键盘事件处理。`dom.js` 的 `h()` 支持 `on*` 事件属性，SVG 构造函数 `s()` 不支持。
- **主题**：主题变量有 `--surface`、`--surface-2`、`--border`、`--text`、`--muted`，深色主题通过 `prefers-color-scheme` 覆盖。

## Goals / Non-Goals

**目标：** 实现与 ZCode 等价的即时提示框、趋势整列悬停、扇区与明细联动，并补上键盘与触屏的可用性，同时减少 Tab 停留点。

**非目标：** 不改数据接口、计费口径、配色、布局和图形种类；不加入缩放、拖拽选区、点击下钻或动画；不引入 Recharts 等图表库或构建步骤。

## Decisions

### 1. 共用提示框模块

新增 `public/js/charts/tooltip.js`，导出 `createTooltip(frame)`，返回 `{show(anchorRect|point, content), hide(), element}`：

- **挂载**：每张图外层包一个 `.chart-frame`（`position:relative`），提示框是其中一个 `div.chart-tip`，带 `role="tooltip"`，默认 `hidden`。
- **内容**：由数据构造，所有文本都用 `h()` 生成文本节点，不使用 `innerHTML`。结构为一行标题，加若干数据行。每个数据行包含色块、名称、等宽数字和弱化单位，可选带上百分比。
- **定位**：鼠标悬停时跟随指针，偏移 12px；键盘和触屏时锚定到目标元素的包围盒。优先放在右下方，超出 `.chart-frame` 右边或下边时翻到左侧或上方，最终坐标夹紧在 frame 内。frame 设 `overflow:visible`，但提示框最大宽度不超过 frame 宽度，因此不会撑出页面横向滚动。
- **无障碍**：提示框显示期间，当前聚焦目标设置 `aria-describedby` 指向它。原有 `<title>` 全部删除，`aria-label` 保留。
- **关闭**：`pointerleave`（离开 frame）、`Escape`、`blur`（焦点移出图表），以及点击 frame 外部（在 document 上注册一次性 `pointerdown` 监听，关闭时移除）。
- **样式**：`.chart-tip` 使用 `var(--surface)` 背景、`var(--border)` 边框、圆角 8px、阴影；标题用 `var(--text)`，名称和单位用 `var(--muted)`；`pointer-events:none`，避免挡住目标。`prefers-reduced-motion` 时不加淡入过渡。

### 2. 事件委托与命中

三张图都在 SVG 根节点上统一监听 `pointermove`、`pointerleave`、`pointerdown`、`keydown`、`focus`、`blur`，不给每个元素单独绑定。命中目标通过 `data-*` 属性识别（如 `data-day`、`data-week`、`data-col`、`data-slice`），数据从渲染时闭包里保存的数组按索引读取。`pointermove` 用 `requestAnimationFrame` 合并，同一目标不重复渲染提示框。

指针类型分开处理：

- `mouse` 和 `pen`：按悬停处理。
- `touch`：在 `pointerdown` 时显示提示框，并阻止随后合成的 `click` 打开其他内容；轻点同一目标再次显示（不切换），轻点外部关闭。

### 3. 热力图

- **焦点**：SVG 根节点 `tabindex=0`、`role="grid"`，格子不再单独可聚焦。内部维护 `active={week,day}`，初始为最近有数据的日期，没有数据时为今天。
- **方向键**：
  - 每日视图：←、→ 按周移动（同一星期几），↑、↓ 按天移动，在周边界处跨列。
  - 每周和累计视图：只有 ←、→ 有效，按列移动。
  - Home、End 跳到最早和最近一格。
- **当前格**：加 `.is-active` 类（描边 `var(--text)`），每周和累计视图对整列 `g.heat-week` 加 `.is-active`，沿用原有的整列描边样式。
- **提示框内容**：
  - 每日视图：标题“10月27日 周一”，数据行“1.2万 token · 34 次 · $0.0123”；有未定价时再加一行“另有 3 次未定价”。
  - 每周视图：标题为“10月19日 – 10月25日”。
  - 累计视图：标题为“截至 10月25日”。
  - 日期按北京日期显示，费用为 `null` 时写“费用未知”。
- **命中**：沿用 8×8 的格子加 2px 间隙。指针落在间隙中时保留上一个目标，避免提示框闪烁。

### 4. 趋势图

- **命中区域**：每个日期渲染一个透明 `rect.trend-hit`，宽度为相邻两点间距，覆盖绘图区高度，带 `data-col`。SVG 根节点 `tabindex=0`，原有数据点去掉 `tabindex`。
- **激活某一列时**：
  - 显示一条竖向参考线 `line.trend-guide`（`var(--border-strong)`）；
  - 把该列各序列的点 `r` 从 2.5 放大到 4，并加 `var(--surface)` 描边；
  - 提示框标题为“10月27日 周一 · 合计 3.4万 token”（费用视图为“合计 $0.12”，只合计已定价部分；有未定价模型时注明“另有未定价”）；
  - 数据行按数值降序，过滤掉数值为 0 的序列（与 ZCode 一致），费用视图中未定价模型显示“未定价”。
- **键盘**：←、→ 移动一列，Home、End 跳到首尾。初始列为最后一天。
- **触屏**：轻点任意位置，按横坐标落到最近的列。

### 5. 环形图与明细联动

- **命中与焦点**：扇区保留圆环描边的画法，加上 `data-slice`；SVG 根节点 `tabindex=0`，用方向键在扇区之间切换（顺时针为 →、↓）。
- **突出效果**：激活扇区的 `stroke-width` 从 20 变为 24；其余扇区加 `.is-dimmed`（`opacity:.35`）。中心文字保持总量不变，避免数字跳动。
- **提示框**：标题为名称，数据行为“1.2万 token · 34.5%”，第二行为可估算费用或“未定价”。
- **联动**：`share()` 返回的明细行带同一 `data-slice`，在共同的父元素上做委托：悬停明细行时激活对应扇区，但不显示提示框（明细里已有同样的数字）；悬停扇区时，对应明细行加 `.is-active` 背景。
- **表格视图**：不受影响。

### 6. 重建与状态

每次切换视图、范围或指标都会整块重建图表。重建前关闭旧提示框，移除 document 上的外部点击监听，新图不继承上一次的激活位置。组件函数签名保持不变，返回的根元素改为 `.chart-frame`，不影响 `views/billing.js` 的 `set()` 用法。明细联动只用到 `share()` 返回的 DOM，不需要 `billing.js` 增加状态。

## Risks / Trade-offs

- **SVG 缩放**：`viewBox` 会随宽度缩放，命中区域按 SVG 坐标计算。指针坐标统一用 `getScreenCTM().inverse()` 换算，避免在 375px 和 1440px 下错位。
- **触屏冲突**：触屏的轻点和页面滚动可能冲突。只在 `pointerdown` 后未移动（位移 <8px）时才视为轻点，不调用 `preventDefault` 阻止滚动。
- **读屏**：热力图改成单个 Tab 停留点后，读屏用户依赖方向键和 `aria-describedby` 获取数值。另外保留现有的表格视图（占比）和文字摘要。热力图暂不提供表格视图，这与现有规格一致。
- **性能**：364 个格子只用一组委托监听，提示框复用同一个元素，不会随重建累积监听器。

## Migration Plan

纯前端改动，没有数据迁移。回退时恢复旧的 `usage.js` 和样式即可，接口与数据不受影响。

## Verification

- **服务器单元测试**：项目没有 DOM 模拟库，也不为此新增依赖。把提示框内容的数据构造（每日、每周、累计文案，趋势的合计、排序、0 值过滤与未定价，占比的费用文本）和定位计算（翻转与夹紧）写成不访问 `document` 的纯函数并导出，在现有 Node 测试中直接导入测试。
- **服务器隔离界面验收**：新增 `test/billing-charts-acceptance.mjs`，沿用 `proposals-ui-acceptance.mjs` 的静态面板加固定数据方式，在 Camoufox 中覆盖以下项目，并在 1440px、375px，浅色、深色下截图：
  - 鼠标悬停热力图格子、趋势空白处、扇区和明细行；
  - 每周和累计视图的整列高亮；
  - 提示框的立即出现与关闭（离开、Esc、点击外部）；
  - 最右、最下目标的翻转与无横向滚动；
  - 触屏模拟轻点；
  - 键盘的 Tab 停留点计数，以及方向键、Home、End；
  - 不出现原生提示。
- **生产检查**：取得发布授权后，在生产面板只读打开计费页做目视检查，不调用模型。
