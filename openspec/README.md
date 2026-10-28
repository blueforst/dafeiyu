# 项目 OpenSpec 使用说明

本项目用 OpenSpec `spec-driven` 管理需求、增量规格、设计与验收任务。使用产品先看 [项目 README](../README.md)；修改需求先读 [项目约定](../AGENTS.md)、[OpenSpec 配置](config.yaml) 和对应提案的全部产物。

**规划结构完成、代码提交、服务器测试、生产发布、真实业务验收是不同状态。** `specs/` 只记录已验证的现有行为；尚未完成的需求保留在 `changes/`，不得因代码已部署而提前同步主规格或归档。

## 当前发布与验收边界

截至 2026-10-28，正式 app／browser 为 **0.1.18.2**，来源 `9d69f92`，成对 healthy，schema **13**，正式构建 **533 项通过**。当前导航为动态、人设、记忆、设置、计费五页，业务保持 **paused／auto**；未定制部署读回通用默认 v2、修订 0。

下列提案的现有代码已进入生产，包括四项新增提案、参考帖子补齐和计费图表交互；**这不表示提案的所有任务已经验收**。真实长帖、模型效果、平台发送与双方回执、业务及长期观察仍按各自清单继续完成。部分 `tasks.md` 的发布勾选尚未随最新证据回填；发布事实看 [发布与实机修复记录](../docs/实施记录/2026-10-28-发布与实机修复.md)，逐项完成条件仍看对应任务，不在本次索引整理中代替验收勾选。

公开提及、搜索与自己帖子下回复已真实只读读通；私信界面就绪、原生结构和账号质量过滤仍在修复／实机复验。原生 X Chat 仍缺可靠时间与入站归属，自动事件为零，不声明自动收发可用。通知“全部”栏继续待真实样本、未启用。

六预设 **240 次**与文风前后对比 **10 次**真实模型调用已获授权，按用户最新要求等待问题全部修好并完成实机复验后执行。当前新增真实模型调用为 **0**，原生产 completed 三条不变；不能写成缺授权，也不能把模拟结果当作已跑完真实批量。

## 已部署代码所涵盖的提案

下表是入口与范围摘要，不是完成清单。每项设计、任务和完整增量规格均保留在原目录。

| 提案与范围 | 设计 | 实施与验收 | 增量规格 |
| --- | --- | --- | --- |
| [七页生产工作流基线](changes/add-seven-page-production-bot/proposal.md)：账号归属、模型计量、人设、记忆、任务、持久出站；当前导航已由五页替代 | [设计](changes/add-seven-page-production-bot/design.md) | [任务](changes/add-seven-page-production-bot/tasks.md) | [规格](changes/add-seven-page-production-bot/specs/) |
| [按账号权限校验 X 发帖字数](changes/add-account-aware-post-limits/proposal.md)：统一生成与发送字数校验；真实长帖权限与完整回执仍待验证 | [设计](changes/add-account-aware-post-limits/design.md) | [任务](changes/add-account-aware-post-limits/tasks.md) | [规格](changes/add-account-aware-post-limits/specs/) |
| [动态首页与五页面板](changes/simplify-panel-activity-feed/proposal.md)：动态、草稿审核、模型库与计费页；原七页入口兼容跳转 | [设计](changes/simplify-panel-activity-feed/design.md) | [任务](changes/simplify-panel-activity-feed/tasks.md) | [规格](changes/simplify-panel-activity-feed/specs/) |
| [回复提示词结构与动态提醒](changes/improve-reply-prompt-context/proposal.md)：稳定前缀、动态上下文及迟到／语言／表情等提醒 | [设计](changes/improve-reply-prompt-context/design.md) | [任务](changes/improve-reply-prompt-context/tasks.md) | [规格](changes/improve-reply-prompt-context/specs/) |
| [消息分级、过滤与公平调度](changes/add-reply-triage/proposal.md)：广告与刷量过滤、同人合并、骚扰冷却、公开每日额度及公平出队 | [设计](changes/add-reply-triage/design.md) | [任务](changes/add-reply-triage/tasks.md) | [规格](changes/add-reply-triage/specs/) |
| [无人值守健康、日报与账号合规](changes/add-unattended-health/proposal.md)：轮次看门狗、浏览器自愈、健康和账号只读检查；实际可靠性与长期观察继续验收 | [设计](changes/add-unattended-health/design.md) | [任务](changes/add-unattended-health/tasks.md) | [规格](changes/add-unattended-health/specs/) |
| [人设回放与回复质量统计](changes/add-persona-replay/proposal.md)：样本比较、费用确认、人工标注与确定性指标；不替代真实模型效果审定 | [设计](changes/add-persona-replay/design.md) | [任务](changes/add-persona-replay/tasks.md) | [规格](changes/add-persona-replay/specs/) |
| [参考帖子遗漏补齐](changes/fill-reference-post-gaps/proposal.md)：引用／卡片、目标上下文、关键词卡、角色经历、链接补录及模型对比；通知“全部”仍待样本且关闭 | [设计](changes/fill-reference-post-gaps/design.md) | [任务](changes/fill-reference-post-gaps/tasks.md) | [规格](changes/fill-reference-post-gaps/specs/) |
| [计费图表交互](changes/add-billing-chart-interaction/proposal.md)：即时提示、日期列悬停、环图联动、触屏与键盘操作 | [设计](changes/add-billing-chart-interaction/design.md) | [任务](changes/add-billing-chart-interaction/tasks.md) | [规格](changes/add-billing-chart-interaction/specs/) |
| [人设预设与默认人设](changes/add-persona-presets/proposal.md)：六个原创 v2 预设、通用默认、关键词卡（含“不给步骤”“被夸”）、编辑器填入与统一人设；240 次真实模型及效果审定未完成 | [设计](changes/add-persona-presets/design.md) | [任务](changes/add-persona-presets/tasks.md) | [规格](changes/add-persona-presets/specs/) |
| [取消消息里的遗忘指令](changes/remove-message-forget-command/proposal.md)：消息不能执行遗忘或恢复，管理员操作与独立账本保留；真实回复抽查待完成 | [设计](changes/remove-message-forget-command/design.md) | [任务](changes/remove-message-forget-command/tasks.md) | [规格](changes/remove-message-forget-command/specs/) |
| [运行状态与浏览器接管分离](changes/separate-run-control-from-takeover/proposal.md)：顶部启动／暂停，设置页接管／释放，释放后继续暂停 | [设计](changes/separate-run-control-from-takeover/design.md) | [任务](changes/separate-run-control-from-takeover/tasks.md) | [规格](changes/separate-run-control-from-takeover/specs/) |
| [回复文风与格式标记](changes/improve-reply-style/proposal.md)：同人近期往来、角色帖去重与格式只标记；真实前后五轮比较及发布后观察待完成 | [设计](changes/improve-reply-style/design.md) | [任务](changes/improve-reply-style/tasks.md) | [规格](changes/improve-reply-style/specs/) |

使用说明与证据：

- [五页与后续提案使用说明](../docs/后续提案实施.md)、[模型库](../docs/模型库.md)、[前端接口](../docs/前端接口.md)
- [七页基线实施记录](../docs/实施记录/2026-10-28-七页提案.md)、[六项后续提案实施记录](../docs/实施记录/2026-10-28-后续提案.md)
- [参考帖子逐条对照](../docs/参考帖子对照.md)、[第三轮补齐与采集修复](../docs/实施记录/2026-10-28-新提案与采集修复.md)、[计费图表交互记录](../docs/实施记录/2026-10-28-计费图表交互.md)
- [四项新增提案隔离验收](../docs/实施记录/2026-10-28-新增提案实现.md)、[最新发布与实机修复](../docs/实施记录/2026-10-28-发布与实机修复.md)、[原生 Chat 只读边界](../docs/新Chat只读适配.md)

记录中的旧版本、模拟调用数和当时的“未发布”表述属于历史快照。当前发布以最近记录和运行读回为准，真实验收仍须有相应证据。

## 仅规划，尚未实现

### 私信每日额度

[提案](changes/add-private-daily-limit/proposal.md) · [设计](changes/add-private-daily-limit/design.md) · [任务](changes/add-private-daily-limit/tasks.md) · [增量规格](changes/add-private-daily-limit/specs/)

当前 **0/8**，只创建规划文件。计划新增私信 `privatePerDay`，默认 **400**，管理员可设 **1–500**；按最近二十四小时滚动计数，为接管时的手动发送预留余量。达到额度后私信继续排队，不触发四小时平台拒绝退避，也不影响公开通道。设置页、队列摘要和健康提示同步显示近二十四小时计数。

现有生产私信只有小时额度，不能把计划值当成已生效保护。该提案是在私信自动回复启用前补齐额度；不改公开自然日额度、出站回执或 unknown 只回查语义。平台限制的来源与统计口径见原提案。

### 回复时段跟随早晚安帖

[提案](changes/add-reply-hours/proposal.md) · [设计](changes/add-reply-hours/design.md) · [任务](changes/add-reply-hours/tasks.md) · [增量规格](changes/add-reply-hours/specs/)

当前 **0/10**，只创建规划文件。计划默认开启回复时段：从晚安计划时间加关闭延迟，到次日早安计划时间，公开回复与私信均不生成、不提交。关闭延迟默认 **30 分钟**，范围 **0–180**；以任务计划时间为准，任务停用、错过或未发成功不改变开关时间。早安任务启用时先等当天任务结束，最迟计划时间后 **15 分钟**开放回复。

关闭期间仍采集排队，排队时效暂停计时；unknown 回查、日程、记忆等任务沿用各自规则，人工接管不受限制。健康停滞与日报延迟扣除关闭时长。生产早晚安任务目前停用；本提案若按默认计划实施，对应 **23:30–08:00** 关闭区间，当前尚无此限制。

这两项提案不新增数据库迁移或模型请求。实施与发布各按原任务验证，不因提案进入仓库自动执行。

## 依赖与维护规则

- 七页基线提案和原计划保留为来源；后续修改以相应 change 的提案、完整增量规格、设计和任务为准，避免设计分叉。
- `fill-reference-post-gaps` 修改七页基线、回复提示词和回放中的能力；归档应在这些来源提案之后。`add-billing-chart-interaction` 应在 `simplify-panel-activity-feed` 之后。
- `remove-message-forget-command` 应在七页基线之后；运行／接管分离应在七页与五页面板之后；文风提案应在七页与回复提示词提案之后。
- `add-private-daily-limit` 应在 `add-reply-triage` 之后；`add-reply-hours` 应在分级、健康及私信日额度提案之后。两项都修改分级能力，并行实施时需协调共享源码与设置入口。
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
