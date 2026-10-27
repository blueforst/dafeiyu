# 文档语言

除非用户明确指定其他语言，所有文档统一使用中文书写。

# 本机负载与执行位置

不在本机运行高负载任务；构建、大规模测试、性能压测、批量渲染和大数据处理等任务放到服务器执行。

# OpenSpec

- 需求、架构和跨模块变更采用 OpenSpec，先阅读 `openspec/README.md` 与 `openspec/config.yaml`。
- 七页生产基线提案为 `openspec/changes/add-seven-page-production-bot/`；按 `proposal.md`、完整增量规格、`design.md`、`tasks.md` 理解范围。旧七页计划保留为来源，后续修改同步到提案，避免两份设计分叉。
- `openspec/specs/` 只记录现有行为；尚未实现的需求保留在 change 的增量规格中，不能因规划完成就提前同步或归档。
- Codex 项目技能位于 `.agents/skills/openspec-*/`。提案整理与业务实施分别记录，任务只有完成验证后才能勾选。

- 本轮候选同时实施六项后续提案：`add-account-aware-post-limits`、`simplify-panel-activity-feed`、`improve-reply-prompt-context`、`add-reply-triage`、`add-unattended-health`、`add-persona-replay`。候选采用动态、人设、记忆、设置、计费五页；生产版本与真实验收状态另记，不能以推送 GitHub 代表发布。
- 后续提案隔离验证使用 `dev/proposals-sync.sh` 与 `dev/proposals-test.sh`，目标为 `/srv/role-workflow-proposals`，不得覆盖已有七页开发副本或生产目录。验收结束清理本轮临时容器、镜像与工作目录，保留最终证据。
