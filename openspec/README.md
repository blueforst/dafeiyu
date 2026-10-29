# 项目 OpenSpec 使用说明

本项目用 OpenSpec `spec-driven` 管理需求、增量规格、设计与验收任务。使用产品先看 [项目 README](../README.md)；修改需求先读 [项目约定](../AGENTS.md)、[OpenSpec 配置](config.yaml) 和对应提案的全部产物。

**规划结构完成、代码提交、服务器测试、生产发布、真实业务验收是不同状态。** `specs/` 只记录已验证的现有行为；尚未完成的需求保留在 `changes/`，不得因代码已部署而提前同步主规格或归档。

## 当前发布与验收边界

截至 2026-10-30，正式 app／browser 为 **0.1.28.1**，来源 `a0dba43`，成对 healthy，schema **14**。动态侧栏及首帧样式、夜间收件和只回复最新一条已发布；713 项单元、七项原生 DOM、75 项适用 UI 和七项正式 UI 通过。真实请求已接受一次，五条消息进入动态及实际上下文，前四条 merged，仅最新一条 queued。最新 running／auto 和回复时段限制保留；真实模型回复及平台回执仍待验收，私信提案 12/13、动态提案 15/15，未同步主规格或归档。见[发布记录](../docs/发布记录/2026-10-30-0.1.28.1.md)。

下列提案的现有代码已进入生产，包括四项新增提案、参考帖子补齐和计费图表交互；**这不表示提案的所有任务已经验收**。真实长帖、模型效果、平台发送与双方回执、业务及长期观察仍按各自清单继续完成。部分 `tasks.md` 的发布勾选尚未随最新证据回填；发布事实看 [发布与实机修复记录](../docs/实施记录/2026-10-28-发布与实机修复.md)，逐项完成条件仍看对应任务，不在本次索引整理中代替验收勾选。

公开提及、搜索与自己帖子下回复真实只读正常。0.1.18.5 已通过原生 Chat 空收件箱专用证据验证，标题、副文、全部、搜索及无截断检查均通过，实际稳定就绪用时 11.089 秒，相关采集代码未变；隔离私信 DOM 41 项、健康 15 项通过，账号 DOM 66 项已由 0.1.18.4 的同份账号代码验证。该批账号检查当时发现简介缺少 AI 披露、未标注自动化账号、质量过滤开启；10 月 29 日按管理员指令已在 X 保存 AI 简介并关联 `@cn4bie`，主页显示 `Automated by @cn4bie`。这些是独立的管理员账号操作，不是程序自动修改资料；该账号操作没有修改质量过滤。手动账号检查复用旧结果已修复并通过服务器 17 项验证，最新生产复核见发布记录。

原生 X Chat 已取得实际入站机器时间、数字身份及一次正常请求接受的证据；暂停下的请求观察事件不提前入队。真实模型回复及双方回执仍待正常流程验收，只读上下文核对不能替代实际回复。通知“全部”栏继续待真实样本、未启用。

真实模型验收已按既定授权启动。旧批 82 次供应商均正常返回，其中 60 次有效草稿、22 次格式／结构失败，无 uncertain；该批已冻结，Pi 费用估算为 0.015768288 美元。0.1.18.6 为七个 JSON 对象生成入口显式传递格式提示，仅 Chat Completions 增加 `response_format: json_object`；纯文本连接检查、旧摘要及原有解析／内容／长度校验保留，`maxRetries=0`，参数被拒绝时不自动降级。

修复后原计划 156 次的主组实际发出 **154 次**，其中 **153 次有效、1 次 GPT 娘解析失败**，该连续组后两轮因前轮失败而阻塞，未调用。另完成通用人设身份／危机边界点验 **2 次**，不混作原主组缺失轮次。加上冻结旧批 82 次与文风对比 10 次，本轮实际共 **248 次，不超过已授权的 250 次**；不能写成原 156 次全通过，也不能把旧批拼成新版完整 240 次验收。

文风旧／新各五轮已完成且独立计量；本样本未证明文风改善，并有误接上文线索。2026-10-28 经逐条复核，用户明确同意“这批先通过吧，修八股以后再考虑”，本批模型与人设效果验收通过，八股文风作为后续非阻断改进；失败与缺轮事实不变。逐项结果、费用和审定范围见 [上一批发布与实机记录](../docs/实施记录/2026-10-28-发布与实机修复.md)；Pi 估算不是供应商实际扣款或账单，本批批准不代表未测场景或平台收发已通过。

## 已部署代码所涵盖的提案

下表是入口与范围摘要，不是完成清单。每项设计、任务和完整增量规格均保留在原目录。

| 提案与范围 | 设计 | 实施与验收 | 增量规格 |
| --- | --- | --- | --- |
| [七页生产工作流基线](changes/add-seven-page-production-bot/proposal.md)：账号归属、模型计量、人设、记忆、任务、持久出站；当前导航已由三页工作区替代 | [设计](changes/add-seven-page-production-bot/design.md) | [任务](changes/add-seven-page-production-bot/tasks.md) | [规格](changes/add-seven-page-production-bot/specs/) |
| [按账号权限校验 X 发帖字数](changes/add-account-aware-post-limits/proposal.md)：统一生成与发送字数校验；真实长帖权限与完整回执仍待验证 | [设计](changes/add-account-aware-post-limits/design.md) | [任务](changes/add-account-aware-post-limits/tasks.md) | [规格](changes/add-account-aware-post-limits/specs/) |
| [动态首页与五页面板](changes/simplify-panel-activity-feed/proposal.md)：动态、草稿审核、模型库与计费页；原七页入口兼容跳转 | [设计](changes/simplify-panel-activity-feed/design.md) | [任务](changes/simplify-panel-activity-feed/tasks.md) | [规格](changes/simplify-panel-activity-feed/specs/) |
| [回复提示词结构与动态提醒](changes/improve-reply-prompt-context/proposal.md)：稳定前缀、动态上下文及迟到／语言／表情等提醒 | [设计](changes/improve-reply-prompt-context/design.md) | [任务](changes/improve-reply-prompt-context/tasks.md) | [规格](changes/improve-reply-prompt-context/specs/) |
| [消息分级、过滤与公平调度](changes/add-reply-triage/proposal.md)：广告与刷量过滤、同平台会话合并、骚扰冷却、公开每日额度及公平出队 | [设计](changes/add-reply-triage/design.md) | [任务](changes/add-reply-triage/tasks.md) | [规格](changes/add-reply-triage/specs/) |
| [无人值守健康、日报与账号合规](changes/add-unattended-health/proposal.md)：轮次看门狗、浏览器自愈、健康和账号只读检查；实际可靠性与长期观察继续验收 | [设计](changes/add-unattended-health/design.md) | [任务](changes/add-unattended-health/tasks.md) | [规格](changes/add-unattended-health/specs/) |
| [人设回放与回复质量统计](changes/add-persona-replay/proposal.md)：样本比较、费用确认、人工标注与确定性指标；不替代真实模型效果审定 | [设计](changes/add-persona-replay/design.md) | [任务](changes/add-persona-replay/tasks.md) | [规格](changes/add-persona-replay/specs/) |
| [参考帖子遗漏补齐](changes/fill-reference-post-gaps/proposal.md)：引用／卡片、目标上下文、关键词卡、角色经历、链接补录及模型对比；通知“全部”仍待样本且关闭 | [设计](changes/fill-reference-post-gaps/design.md) | [任务](changes/fill-reference-post-gaps/tasks.md) | [规格](changes/fill-reference-post-gaps/specs/) |
| [计费图表交互](changes/add-billing-chart-interaction/proposal.md)：即时提示、日期列悬停、环图联动、触屏与键盘操作 | [设计](changes/add-billing-chart-interaction/design.md) | [任务](changes/add-billing-chart-interaction/tasks.md) | [规格](changes/add-billing-chart-interaction/specs/) |
| [人设预设与默认人设](changes/add-persona-presets/proposal.md)：六个原创 v2 预设、通用默认、关键词卡（含“不给步骤”“被夸”）、编辑器填入与统一人设；真实调用及效果审定以最新记录为准 | [设计](changes/add-persona-presets/design.md) | [任务](changes/add-persona-presets/tasks.md) | [规格](changes/add-persona-presets/specs/) |
| [取消消息里的遗忘指令](changes/remove-message-forget-command/proposal.md)：消息不能执行遗忘或恢复，管理员操作与独立账本保留；真实回复抽查通过 | [设计](changes/remove-message-forget-command/design.md) | [任务](changes/remove-message-forget-command/tasks.md) | [规格](changes/remove-message-forget-command/specs/) |
| [运行状态与浏览器接管分离](changes/separate-run-control-from-takeover/proposal.md)：顶部启动／暂停，设置页接管／释放，释放后继续暂停 | [设计](changes/separate-run-control-from-takeover/design.md) | [任务](changes/separate-run-control-from-takeover/tasks.md) | [规格](changes/separate-run-control-from-takeover/specs/) |
| [回复文风与格式标记](changes/improve-reply-style/proposal.md)：同人近期往来、角色帖去重与格式只标记；前后五轮真实比较与本批审定通过，八股改进延后，发布后观察仍待完成 | [设计](changes/improve-reply-style/design.md) | [任务](changes/improve-reply-style/tasks.md) | [规格](changes/improve-reply-style/specs/) |

使用说明与证据：

- [候选与后续提案使用说明](../docs/后续提案实施.md)、[模型库](../docs/模型库.md)、[前端接口](../docs/前端接口.md)
- [七页基线实施记录](../docs/实施记录/2026-10-28-七页提案.md)、[六项后续提案实施记录](../docs/实施记录/2026-10-28-后续提案.md)
- [参考帖子逐条对照](../docs/参考帖子对照.md)、[第三轮补齐与采集修复](../docs/实施记录/2026-10-28-新提案与采集修复.md)、[计费图表交互记录](../docs/实施记录/2026-10-28-计费图表交互.md)
- [四项新增提案隔离验收](../docs/实施记录/2026-10-28-新增提案实现.md)、[最新发布与实机修复](../docs/实施记录/2026-10-28-发布与实机修复.md)、[原生 Chat 只读边界](../docs/新Chat只读适配.md)

记录中的旧版本、模拟调用数和当时的“未发布”表述属于历史快照。当前发布以最近记录和运行读回为准，真实验收仍须有相应证据。

## 本轮五项：已发布，跨夜开放观察待完成

本轮五项共 **71/72** 项任务完成；五项均已随 0.1.19 部署，真实试聊取得核心证据且用户随后明确要求发布。仅回复时段次日实际开放后的生产观察仍待完成，不因当前夜间关闭和零提交就勾选。首轮推送后完成鲁棒性修复，最终服务器构建与 **647/647** 回归通过，十七套界面与调用链验收共 **169** 组通过，另保留首轮未改 CSS 的 16 组兼容证据；详见[总实施与证据](../docs/实施记录/2026-10-28-五项剩余提案候选.md)。未同步主规格或归档。

### 私信每日额度

[提案](changes/add-private-daily-limit/proposal.md) · [设计](changes/add-private-daily-limit/design.md) · [任务](changes/add-private-daily-limit/tasks.md) · [增量规格](changes/add-private-daily-limit/specs/)

当前 **8/8**，已发布并完成生产读回。新增私信 `privatePerDay`，默认 **400**，管理员可设 **1–500**；按最近二十四小时滚动计数，为接管时的手动发送预留余量。达到额度后私信继续排队，不触发四小时平台拒绝退避，也不影响公开通道。设置页、队列摘要和健康提示同步显示近二十四小时计数。

生产现已启用小时与最近二十四小时双层额度，当前读回 0/400；不为验收制造私信。该提案在私信自动回复启用前补齐额度；不改公开自然日额度、出站回执或 unknown 只回查语义。平台限制的来源与统计口径见原提案。

### 回复时段跟随早晚安帖

[提案](changes/add-reply-hours/proposal.md) · [设计](changes/add-reply-hours/design.md) · [任务](changes/add-reply-hours/tasks.md) · [增量规格](changes/add-reply-hours/specs/)

当前 **9/10**，0.1.19 已发布、当前关闭状态已读回；仅次日实际开放后的观察未完成。生产默认开启回复时段：从晚安计划时间加关闭延迟，到次日早安计划时间，公开回复与私信均不生成、不提交。关闭延迟默认 **30 分钟**，范围 **0–180**；以任务计划时间为准，任务停用、错过或未发成功不改变开关时间。早安任务启用时先等当天任务结束，最迟计划时间后 **15 分钟**开放回复。

关闭期间仍采集排队，排队时效暂停计时；unknown 回查、日程、记忆等任务沿用各自规则，人工接管不受限制。健康停滞与日报延迟扣除关闭时长。生产早晚安任务目前停用；已核对默认计划，对应 **23:30–08:00** 关闭区间，当前限制已生效但业务仍暂停。

这两项提案没有新增数据库迁移或模型请求。默认值已进入生产，时段跨夜观察按原任务继续保留；不会为了验收恢复自动处理。

### 面板改版（三份，以下为依赖顺序）

三份提案共用一套参照 DeepSeek Harness 网页版式的统一设计：左栏列表加主区，按需带右栏，整页铺满，左右栏都能收起，窄屏用抽屉。前端仍为原生 HTML/CSS/ES 模块，不使用对方的品牌素材。管理员确认的草图是一个单独的 HTML 文件 [panel-redesign-mockup.html](changes/add-persona-workspace/panel-redesign-mockup.html)，含动态、人设、设置三页。

1. **人设工作区、多人设与正常流程试聊**
   [提案](changes/add-persona-workspace/proposal.md) · [设计](changes/add-persona-workspace/design.md) · [任务](changes/add-persona-workspace/tasks.md) · [增量规格](changes/add-persona-workspace/specs/)

   当前 **26/26**，有限真实试聊样本及生产发布验收完成。未测边界保留，主要内容：
   - 统一设计的外壳与组件；
   - 人设页分人设、日程、试聊三种模式；
   - 可保存多个人设，其中一个“使用中”；
   - 试聊以测试用户身份走正常回复流程：数据存在独立的 `chat-test/` 目录，不占额度、不受时段限制，计费用途为“试聊”。

2. **设置页改版**
   [提案](changes/redesign-settings-workspace/proposal.md) · [设计](changes/redesign-settings-workspace/design.md) · [任务](changes/redesign-settings-workspace/tasks.md) · [增量规格](changes/redesign-settings-workspace/specs/)

   当前 **16/16**，生产三页、十一设置项及原值保存不恢复业务均已验收。主要内容：
   - 左栏一项一页，共四组十一项；
   - 记忆页和计费页并入设置，顶部导航改为动态、人设、设置三项；
   - 不改任何设置的含义和接口。

3. **动态页改版**
   [提案](changes/redesign-feed-workspace/proposal.md) · [设计](changes/redesign-feed-workspace/design.md) · [任务](changes/redesign-feed-workspace/tasks.md) · [增量规格](changes/redesign-feed-workspace/specs/)

   当前 **12/12**，生产会话列表及待处理计数读回通过，未增加索引迁移。主要内容：
   - 用户即会话：左栏按身份列出会话，主区显示往来，草稿在对话中审核，右栏显示详情；
   - 新增两个只读的会话查询接口；
   - 草稿审核与出站规则不变。

## 设置页细节、跨渠道记忆与时区中立：已发布

[提案](changes/refine-settings-memory-timezone/proposal.md) · [设计](changes/refine-settings-memory-timezone/design.md) · [任务](changes/refine-settings-memory-timezone/tasks.md) · [增量规格](changes/refine-settings-memory-timezone/specs/)

2026-10-29 根据管理员试用 0.1.19 的反馈整理，当前 **18/19**，0.1.20 已发布；仅真实私信样本未取得，平台自动关联保持关闭。主要内容：

- 设置左栏改用与另外两页相同的条目样式和正文色，去掉文字摘要，只在需要处理时显示状态圆点；
- 健康页按六组排成表格，账号检查并入“账号”组，日报改为表格；只改展示；
- 新增公开与私信身份关联（试聊自动、平台读取需真实样本、管理员手动），召回改为双向：私信可用公开往来，公开回复只拿私信长期记忆作背景，并用八字重合检查兜底；
- 提示词标明北京时间是角色这边的时间，不按它推断对方作息，迟到提醒不再按时段问候，版本升为 `reply-context-v5`。

## 触发卡按需读取与模型参数精简：已发布0.1.21

2026-10-29 两份提案已随0.1.21发布，保持paused／auto；验收与回退见[发布记录](../docs/发布记录/2026-10-29-0.1.21.md)。

### 触发卡改为按需读取

[提案](changes/convert-trigger-cards-to-skills/proposal.md) · [设计](changes/convert-trigger-cards-to-skills/design.md) · [任务](changes/convert-trigger-cards-to-skills/tasks.md) · [增量规格](changes/convert-trigger-cards-to-skills/specs/)

当前 **20/20**。主要内容：

- 取消关键词触发；卡片只填标题、什么时候用、内容；“被问到才用”的分区并入触发卡。
- 底层按 skill 的方式工作：system 常驻目录，回复模型用原生工具调用读取卡片内容，取消单独的语义路由请求。
- 一次回复最多20次读取／执行，最终草稿另用submit_draft；虚构日程和早晚安帖带全部卡片。
- 内置预设升至第 3 版；已有人设启动时一次性升级并备份；人设文件升至第 2 版。
- 连接测试包含一次工具调用。

### 模型参数精简

[提案](changes/simplify-model-params/proposal.md) · [设计](changes/simplify-model-params/design.md) · [任务](changes/simplify-model-params/tasks.md) · [增量规格](changes/simplify-model-params/specs/)

当前 **8/8**。删除模型参数中的“回复长度上限”和“超时”：输出上限取模型自身最大值，回复长度只受 X 账号发帖限制约束；每次请求固定 180 秒保护时限。实施时同步修改 `config.yaml` 中“默认 4096 token”的约定。

## 试聊与动态对话排版改版：已发布0.1.22

[提案](changes/redesign-conversation-layout/proposal.md) · [设计](changes/redesign-conversation-layout/design.md) · [任务](changes/redesign-conversation-layout/tasks.md) · [增量规格](changes/redesign-conversation-layout/specs/) · [草图](changes/redesign-conversation-layout/design-mockup.html)

2026-10-29 根据管理员“试聊界面太丑、主要是排版”和“动态页也优化一下”的反馈整理。管理员从两种试聊草图中选定“对话优先”，并确认了按同一思路改的动态页草图。当前 **17/17**，已随0.1.22发布；十八套192组界面、682项回归、生产只读8项通过，无新增模型调用。十六张四宽浅深截图及回退边界见[发布记录](../docs/发布记录/2026-10-29-0.1.22.md)。只改前端：

- **两页共用：**
  - 对方消息只留气泡；时间改为五分钟或跨日分隔。
  - 角色一侧带人设首字头像和人设名。
  - 时间、分级、费用、回执等摘要只在悬停或选中时显示；需要关注的结果始终可见；选中只加浅灰底。
  - 头像改为可读配色；右栏名称与数值对齐。
- **试聊：** 渠道切换分隔线；卡片标签、复制、失败重试；模型和 token 只在右栏；输入区改为灰色大圆角框，控件在框内，处理中发送变停止。
- **动态：** 状态放在人设名旁，“已发送”最安静，其余上色并写原因；草稿改为圆角编辑框，按钮在框内；其他操作进入下方操作行；左栏状态改为彩色文字。
- **不改：** 处理流程、接口、数据、计费、草稿规则和状态名称。

## 设置页紧凑排版与高级设置收起：已发布并完成草图返修

[提案](changes/compact-settings-pages/proposal.md) · [设计](changes/compact-settings-pages/design.md) · [任务](changes/compact-settings-pages/tasks.md) · [增量规格](changes/compact-settings-pages/specs/) · [草图目录](changes/compact-settings-pages/mockups/)

2026-10-29 根据管理员选定的五份设置页草图整理实施，连同后续视觉返修与真实任务历史窄屏修复共 **40/40** 项完成，已随 **0.1.25.1** 发布。生产只读 **9/9** 通过，见[发布记录](../docs/发布记录/2026-10-29-0.1.25.1.md)：

- **共用组件与紧凑版式：** 新增 `.ws-cols`、`.ws-card`、`.ws-num`、`.ws-time`、`.ws-switch`、`.ws-stats`、`.ws-row-actions`、`.ws-empty-line`、`advanced()`、`advancedDialog()`、`fmtUsd()`、`rowActions()`、`tagInput()`。
- **模型与服务商：** 左栏只列已添加服务商并配 `✎` 编辑弹窗；接口协议改为模型属性（`LibraryModel.api`），自定义服务商拉取自动依次探测 OpenAI／Anthropic 兼容端点；新增星标（`PUT /api/model/library/:key/stars`，支持拖拽与 `Alt+↑/↓` 排序）、近 30 天最近使用（`lastUsedAt`）、四项缓存价格提示与手动模型删除（`DELETE /api/model/library/:key/models/:id`）。
- **消息时效合并：** 取消优先／普通两档时效，合并为单一 `maxAgeHours`（默认 3 小时，范围 1–48），在“消息分级与过滤”的高级设置中维护，启动一次性迁移并生成备份。
- **十一项设置页重排：** 运行与发送（三卡首屏＋2×2 额度表）、定时任务（24 小时“今天的安排”时间轴＋紧凑表）、消息分级与过滤（统计条＋标签输入＋高级设置）、记忆（双视图切换＋策略弹窗＋身份详情三标签＋登记经历弹窗）、计费（页头范围切换＋堆叠柱状图与模型占比并排＋紧凑热力图＋收起流水）、浏览器接管与采集来源、健康与日报（需关注置顶＋六组状态胶囊＋日报紧凑表）、日志阶段与队列（事件摘要表＋按日分隔＋300ms 自动筛选）、任务执行历史（按任务计数胶囊＋连续成功合并 `groupRuns`）。

调用流水的参考表格增量另完成三项：七列摘要、鼠标及键盘展开、懒加载分页与筛选竞态。紧凑设置提案连同提示生命周期及日志类别修复累计 **47/47**，已随 0.1.26 发布。

## 人设编辑区目录加编辑：0.1.26 已发布

[提案](changes/redesign-persona-editor/proposal.md) · [设计](changes/redesign-persona-editor/design.md) · [任务](changes/redesign-persona-editor/tasks.md) · [增量规格](changes/redesign-persona-editor/specs/) · [草图](changes/redesign-persona-editor/mockups/persona-editor.html)

2026-10-29，管理员选定这一版草图。当前完成 **21/21** 项。管理员确认部署后随 0.1.26 发布；追加提示窗及日志修复后，693 项单元、十二套累计 126 项 UI、生产只读 11/11 通过，保留 148 张生产截图。参见[发布记录](../docs/发布记录/2026-10-29-0.1.26.md)。

本提案只改人设模式下“我的人设”和内置预设的编辑区：

- **版式：** 主区分为左侧段落目录和右侧单项编辑区，取代原来的两列卡片和 5 行小框。
- **目录：** 分“始终生效／触发卡／只读”三组，每项写字数和开头两行，项与项之间有分隔线，不加占比条。
- **编辑：** 分区正文用一个撑满的输入框；触发卡用卡名、什么时候用、内容三个输入框。
- **只读：** 能改的一律是白底带边框的输入框；固定规则、建议简介和内置预设用灰底只读区，并标“只读”。

不改的部分：后端、接口、数据格式、日程、试聊、动态提醒和回放。

## 依赖与维护规则

- `redesign-conversation-layout` 修改的 `chat-test`“本轮诊断”以 `convert-trigger-cards-to-skills` 修改后的文字为基础，`activity-feed` 两项修改以 `redesign-feed-workspace` 为基础，`panel-design-system` 新增在 `add-persona-workspace` 之上；应在这三份之后归档。实施时不得回退触发卡提案对读取卡片和工具调用的展示。
- `convert-trigger-cards-to-skills` 修改七页基线、参考补齐、人设预设、人设工作区、回复提示词、文风、设置细节、回放、人设文件和五页面板中的能力，归档应在这些来源提案之后；`simplify-model-params` 应在五页面板之后归档。两者都修改 `model-configuration`，但改的是不同需求。

- 七页基线提案和原计划保留为来源；后续修改以相应 change 的提案、完整增量规格、设计和任务为准，避免设计分叉。
- `fill-reference-post-gaps` 修改七页基线、回复提示词和回放中的能力；归档应在这些来源提案之后。`add-billing-chart-interaction` 应在 `simplify-panel-activity-feed` 之后。
- `remove-message-forget-command` 应在七页基线之后；运行／接管分离应在七页与五页面板之后；文风提案应在七页与回复提示词提案之后。
- `add-private-daily-limit` 应在 `add-reply-triage` 之后；`add-reply-hours` 应在分级、健康及私信日额度提案之后。两项都修改分级能力，并行实施时需协调共享源码与设置入口。
- 面板改版三份提案按 `add-persona-workspace` → `redesign-settings-workspace` → `redesign-feed-workspace` 的顺序实施和归档。三份都排在七页基线、五页面板、运行／接管分离、人设预设、人设回放和参考补齐之后。`add-reply-hours`、`add-private-daily-limit` 新增的时段和额度检查只能放在生产路径，不能影响试聊。
- `refine-settings-memory-timezone` 修改面板改版三份提案、七页基线的记忆可见范围和回复提示词提案中的能力，归档应在这些来源提案之后；它改写了试聊“公开与私信记忆分开”的场景，实施时以本提案为准。
- `redesign-persona-editor` 新增的 `persona-management` 三项要求建立在 `convert-trigger-cards-to-skills`（触发卡字段）、`add-persona-presets`（预设只读与建议简介）和 `add-persona-workspace`（工作区版式、离开确认）之上，应在这三份之后归档；实施时不得改动日程、试聊、动态提醒和回放页面。
- 未完成任务不得归档。同步主规格前核对实际行为和全部验收证据；CLI 显示规划产物完成只表示可进入实施。
- 修改需求时同步提案、规格、设计和任务；任务只在完整验收条件通过后勾选。构建、自动化测试、批量模型及界面验收只在服务器独立环境运行，不使用生产 profile 跑模拟测试。

## 目录与工作流

```text
openspec/
  config.yaml                       # 中文约定、技术背景与产物规则
  specs/                            # 已验证的现有行为基线
  changes/<change>/
    .openspec.yaml                  # change 元数据
    proposal.md                     # 为什么改、改什么
    design.md                       # 数据流、状态、兼容、验证与回退
    tasks.md                        # 实施步骤及各项验收条件
    specs/<capability>/spec.md       # 新增或修改的行为
.agents/skills/openspec-*/           # Codex 工作流集成
```

主规格入口：[导航](specs/panel-navigation/spec.md)、[记忆](specs/conversation-memory/spec.md)、[模型配置](specs/model-configuration/spec.md)。它们尚未吸收所有 change 的增量，不能把主规格目录视为当前全部功能清单。

项目产物正文使用中文；保留 OpenSpec 所需的 `Purpose`、`Requirement`、`Scenario`、`MUST/SHALL` 和 `WHEN/THEN` 关键字。配置中的旧版本上下文属于历史来源，实施前须与当前发布和实际账号核对。

Codex 集成位于 `.agents/skills/`，包含提出变更、探索、实施、更新、同步规格和归档六个流程。例如 `$openspec-propose` 用于规划，`$openspec-apply-change <change>` 用于实施。技能入口不代表自动取得模型调用、发布或恢复业务的授权；沿用当前会话已确认的范围和顺序。

## 服务器 CLI 校验

既有独立校验工具使用 `@fission-ai/openspec@1.15.0`，位于服务器 `/srv/role-workflow-openspec-tools`，不加入业务运行依赖。规划文件同步到隔离目录 `/srv/role-workflow-openspec-authoring`，不向生产目录初始化或同步：

```sh
rsync -az --delete openspec/ dsh:/srv/role-workflow-openspec-authoring/openspec/
```

以下命令在服务器执行：

```sh
cd /srv/role-workflow-openspec-authoring
export OPENSPEC_TELEMETRY=0
export DO_NOT_TRACK=1
OPENSPEC=/srv/role-workflow-openspec-tools/node_modules/.bin/openspec
"$OPENSPEC" list --specs
"$OPENSPEC" status --change add-seven-page-production-bot
"$OPENSPEC" validate --all --strict --no-interactive
"$OPENSPEC" instructions apply --change add-seven-page-production-bot --json
```

单项校验可用 `validate <change> --strict --no-interactive`。校验通过只证明规划结构有效，不替代业务测试、真实平台验收或任务完成。

参考：[OpenSpec 官方入门](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md)、[CLI 说明](https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md)。

## 人设文件导入与导出

[提案](changes/add-persona-file-transfer/proposal.md) · [任务](changes/add-persona-file-transfer/tasks.md)。当前 **3/3**，已随 0.1.20 发布；支持本地 JSON 下载、文件选择导入，新建未使用项。


## 同文重复降优先：已发布0.1.21

[提案](changes/refine-duplicate-message-triage/proposal.md) · [设计](changes/refine-duplicate-message-triage/design.md) · [任务](changes/refine-duplicate-message-triage/tasks.md)

2026-10-29 管理员确认，同文不再直接硬过滤；同一账号、同一渠道一小时达到阈值只降普通优先级，重点名单与人工操作保留优先。广告过滤及所有出站、额度和暂停规则不变，无新迁移。随本轮一起验证与发布。
