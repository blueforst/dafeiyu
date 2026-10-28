# 项目 OpenSpec 使用说明

本项目用 OpenSpec `spec-driven` 管理需求、增量规格、设计与验收任务。使用产品先看 [项目 README](../README.md)；修改需求先读 [项目约定](../AGENTS.md)、[OpenSpec 配置](config.yaml) 和对应提案的全部产物。

**规划结构完成、代码提交、服务器测试、生产发布、真实业务验收是不同状态。** `specs/` 只记录已验证的现有行为；尚未完成的需求保留在 `changes/`，不得因代码已部署而提前同步主规格或归档。

## 当前发布与验收边界

截至 2026-10-29，正式 app／browser 为 **0.1.19.1**，构建来源 `f29715f62b32467642a8e65730003f75fc181489`，成对 healthy，schema **13**，正式构建 **647/647** 通过。本次左栏入口修复的组件与三工作区 **43 组**验收、生产实际位置核验通过；保留发布前使用中人设、用户新建项、模型和会话，业务保持 **paused／auto**。见[本次发布](../docs/发布记录/2026-10-29-0.1.19.1.md)；原三页只读与十一设置项证据见[0.1.19 记录](../docs/发布记录/2026-10-29-0.1.19.md)。

下列提案的现有代码已进入生产，包括四项新增提案、参考帖子补齐和计费图表交互；**这不表示提案的所有任务已经验收**。真实长帖、模型效果、平台发送与双方回执、业务及长期观察仍按各自清单继续完成。部分 `tasks.md` 的发布勾选尚未随最新证据回填；发布事实看 [发布与实机修复记录](../docs/实施记录/2026-10-28-发布与实机修复.md)，逐项完成条件仍看对应任务，不在本次索引整理中代替验收勾选。

公开提及、搜索与自己帖子下回复真实只读正常。0.1.18.5 已通过原生 Chat 空收件箱专用证据验证，标题、副文、全部、搜索及无截断检查均通过，实际稳定就绪用时 11.089 秒，相关采集代码未变；隔离私信 DOM 41 项、健康 15 项通过，账号 DOM 66 项已由 0.1.18.4 的同份账号代码验证。该批账号检查当时发现简介缺少 AI 披露、未标注自动化账号、质量过滤开启；10 月 29 日按管理员指令已在 X 保存 AI 简介并关联 `@cn4bie`，主页显示 `Automated by @cn4bie`。这些是独立的管理员账号操作，不是程序自动修改资料；该账号操作没有修改质量过滤。手动账号检查复用旧结果已修复并通过服务器 17 项验证，最新生产复核见发布记录。

原生 X Chat 仍缺实际入站时间、归属与双方回执样本，自动私信事件为零，不声明自动私信收发可用；空收件箱与只读检查不能替代这些验收。通知“全部”栏继续待真实样本、未启用。

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

## 依赖与维护规则

- 七页基线提案和原计划保留为来源；后续修改以相应 change 的提案、完整增量规格、设计和任务为准，避免设计分叉。
- `fill-reference-post-gaps` 修改七页基线、回复提示词和回放中的能力；归档应在这些来源提案之后。`add-billing-chart-interaction` 应在 `simplify-panel-activity-feed` 之后。
- `remove-message-forget-command` 应在七页基线之后；运行／接管分离应在七页与五页面板之后；文风提案应在七页与回复提示词提案之后。
- `add-private-daily-limit` 应在 `add-reply-triage` 之后；`add-reply-hours` 应在分级、健康及私信日额度提案之后。两项都修改分级能力，并行实施时需协调共享源码与设置入口。
- 面板改版三份提案按 `add-persona-workspace` → `redesign-settings-workspace` → `redesign-feed-workspace` 的顺序实施和归档。三份都排在七页基线、五页面板、运行／接管分离、人设预设、人设回放和参考补齐之后。`add-reply-hours`、`add-private-daily-limit` 新增的时段和额度检查只能放在生产路径，不能影响试聊。
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
