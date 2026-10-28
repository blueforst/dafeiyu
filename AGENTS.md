# 文档语言

除非用户明确指定其他语言，所有文档统一使用中文书写。

# 本机负载与执行位置

不在本机运行高负载任务；构建、大规模测试、性能压测、批量渲染和大数据处理等任务放到服务器执行。

# OpenSpec

- 需求、架构和跨模块变更采用 OpenSpec，先阅读 `openspec/README.md` 与 `openspec/config.yaml`。
- 七页生产基线提案为 `openspec/changes/add-seven-page-production-bot/`；按 `proposal.md`、完整增量规格、`design.md`、`tasks.md` 理解范围。旧七页计划保留为来源，后续修改同步到提案，避免两份设计分叉。
- `openspec/specs/` 只记录现有行为；尚未实现的需求保留在 change 的增量规格中，不能因规划完成就提前同步或归档。
- Codex 项目技能位于 `.agents/skills/openspec-*/`。提案整理与业务实施分别记录，任务只有完成验证后才能勾选。

- 正式 app／browser 为 0.1.19.1，schema 13，来源 f29715f；导航为动态、人设、设置三页，生产保持 paused／auto。已取得正式构建、生产只读和有限真实试聊证据；跨夜开放与既有平台收发边界看 README 和发布记录，不能把部署等同于所有真实业务验收。
- 本轮五项已部署功能为 `add-private-daily-limit`、`add-reply-hours`、`add-persona-workspace`、`redesign-settings-workspace`、`redesign-feed-workspace`。采用动态、人设、设置三页，人设库与独立正常流程试聊均按相应增量规格实现；一个试聊会话模拟一个用户，公开消息保留各自线程 ID，不跨线程合并。
- 新版界面总回归入口为 `dev/workspace-ui-test.sh`；保留原验收脚本的业务断言，迁移到新位置，不能以新冒烟用例取代原覆盖。真实模型效果与生产发布需要独立证据，未满足的任务继续留空。
- 后续提案隔离验证使用 `dev/proposals-sync.sh` 与 `dev/proposals-test.sh`，目标为 `/srv/role-workflow-proposals`，不得覆盖已有七页开发副本或生产目录。验收结束清理本轮临时容器、镜像与工作目录，保留最终证据。
