# 项目 OpenSpec 使用说明

本项目使用 OpenSpec `spec-driven` 工作流管理需求、规格、技术设计和实施任务。规划、服务器隔离实现与生产发布分别记录，CLI 规划状态不代表业务已经上线。

## 当前提案

- [七页面板与生产角色工作流](changes/add-seven-page-production-bot/proposal.md)：动机、范围与能力清单。
- [技术设计](changes/add-seven-page-production-bot/design.md)：接口、数据流、互斥、迁移、失败与回退。
- [实施任务](changes/add-seven-page-production-bot/tasks.md)：按依赖排序、逐项包含验证方式；进展和证据见[实施记录](../docs/实施记录/2026-10-28-七页提案.md)。
- [增量规格](changes/add-seven-page-production-bot/specs/)：八项能力及可验收场景。

`specs/` 当前只登记已存在的导航、记忆及模型配置基线；未实现能力只在 `changes/` 中。CLI 显示规划产物完成只代表可进入实施，不代表业务任务完成，也不应据此归档。

## 本轮后续提案候选

六项提案已有 83/105 项按完整条件验收。服务器 325 项回归和 40 组界面／浏览器检查通过；真实长帖、模型费用、生产发布和观察等 22 项继续保留，详见[最终实施记录](../docs/实施记录/2026-10-28-后续提案.md)。

- [按账号权限校验 X 发帖字数](changes/add-account-aware-post-limits/proposal.md)：分别识别原创和公开回复的长帖能力，统一生成与发送校验；包含设计、增量规格与实施任务，本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。
- [动态首页与面板精简](changes/simplify-panel-activity-feed/proposal.md)：五页面板、草稿处理、多服务商模型库，以及按 ZCode 用量统计样式重做的计费页；本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。
- [回复提示词结构与动态提醒](changes/improve-reply-prompt-context/proposal.md)：稳定前缀分层、命中规则靠近生成位置、迟到／语言／开头去重／表情节制提醒；本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。
- [消息分级、过滤与公平调度](changes/add-reply-triage/proposal.md)：入队分级、广告与刷量过滤、同一用户合并、骚扰冷却、公开每日额度，受限通道不占名额；本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。
- [无人值守健康、日报与账号合规](changes/add-unattended-health/proposal.md)：轮次超时与看门狗、浏览器内存自愈、健康告警、每日日报、账号受限识别与合规只读检查；不含外部推送，本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。
- [人设回放对比与回复质量统计](changes/add-persona-replay/proposal.md)：真实样本新旧人设批量对比、人工标注与确定性质量指标；本轮已进入实现与服务器隔离验证，进度以 tasks.md 和[本轮记录](../docs/实施记录/2026-10-28-后续提案.md)为准。

后四项来自对参考帖子的第二轮扫描，逐条对照见 [参考帖子对照](../docs/参考帖子对照.md)。

## 目录与维护方式

```text
openspec/
  config.yaml                         # 中文约定、技术背景与各产物规则
  specs/                              # 已实现行为基线
  changes/add-seven-page-production-bot/
    .openspec.yaml                    # change 元数据
    proposal.md                       # 为什么改、改什么
    design.md                         # 如何实现
    tasks.md                          # 业务实施与验收
    specs/<capability>/spec.md         # 新增或修改的行为
.agents/skills/openspec-*/             # 官方生成的 Codex 集成
```

项目产物正文使用中文；`Purpose`、`Requirement`、`Scenario`、`MUST`、`WHEN/THEN` 等保留 OpenSpec 格式关键字。Codex 技能保留官方生成结构，其执行产物遵循项目中文配置。

修改需求时先同步提案、增量规格、设计与相应任务，避免仅修改旧计划。主规格在实现并验证后才同步新行为。各模块测试和文档随任务完成，不集中拖到发布阶段。

## CLI 与服务器校验

本次采用官方 npm 包 `@fission-ai/openspec@1.15.0`，安装在服务器独立工具目录 `/srv/role-workflow-openspec-tools`；不加入业务 package.json，不修改服务运行依赖。服务器校验镜像目录为 `/srv/role-workflow-openspec-authoring`，其内容由当前工作副本的 `openspec/` 单向同步。

本机同步规划文档到该隔离目录：

```sh
rsync -az --delete openspec/ dsh:/srv/role-workflow-openspec-authoring/openspec/
```

在服务器执行：

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

单独校验提案可使用 `validate add-seven-page-production-bot --strict --no-interactive`。需要在其他开发机安装 CLI 时使用同版本官方包，再在本项目目录运行对应命令；不要针对生产运行目录初始化或镜像同步。

## Codex 使用

项目集成由官方 `openspec init --tools codex --profile core --language zh-CN` 生成，位于 `.agents/skills/`。当前包含提出变更、探索、实施、更新、同步规格和归档六个流程；新会话可选择相应技能，也可以直接说明要处理的提案和操作。

- 整理提案：`$openspec-propose`。
- 实施当前提案：`$openspec-apply-change add-seven-page-production-bot`。
- 按实现进展更新任务；没有完成证据不得勾选。
- 未实施完不执行规格同步和归档，不把设计文档误作上线状态。

参考：[OpenSpec 官方入门](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md)、[CLI 说明](https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md)。
