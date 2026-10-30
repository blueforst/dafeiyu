# 文档语言

除非用户明确指定其他语言，所有文档统一使用中文书写。

# 本机负载与执行位置

不在本机运行高负载任务；构建、大规模测试、性能压测、批量渲染和大数据处理等任务放到服务器执行。

# 设计语言

前端界面、交互草图、组件样式与视觉变更统一使用根目录 `DESIGN.md` 进行设计（工作区接口与实现说明同步见 `docs/设计规范.md`）。新增或修改界面组件时，必须遵循 `DESIGN.md` 定义的色彩令牌、排版层级、圆角阶梯令牌（`--r-*`）与内外同心圆角规则，禁止硬编码散乱的圆角、颜色或尺寸值。

# OpenSpec

- 2026-10-30 公开链路正式0.1.28.7／cc0c9e17c456d58bc627ffaaae6dca571f65a484已成对healthy，最终完整756项、公开DOM十五项、broker四项通过。主动根帖及A3／A4／B共四笔真实公开出站confirmed，原根帖与A3均沿原journal回查且未重发；A4正常own-post-replies、B正常mentions，各单次真实reply调用。A3／A4／B生产快照分别验证跨帖来言、已确认assistant前文、独立新线程与当前去重，未冒充draft已发、未注入私信正文。搜索仅confirmed-empty，搜索正例未验，不能称所有来源均通过。详见docs/发布记录/2026-10-30-0.1.28.7.md。
- reply-fallback broker首轮1/2已独立诊断为Camoufox isolated-world下fixture exposeBinding不可用，生产helper实际找到并点击了正确Replies标签。最终仅fixture改用同源/fixture/replies-tab-click fetch，未为夹具放宽生产helper；失败过程保留。
- 本轮11/11新增公开内容已逐条UI删除并核对原链接不存在；原两条Ciallo仍Ceyi可读。最终审计确认私信6行摘要、四笔公开confirmed与目标、旧unknown及精确审核指纹保留；两容器83份dist均匹配已验证编译产物，调试监听关闭。累计18次模型调用，Pi估算$0.00691941、保守峰价$0.0228705，未知价格及pending为零；预算进程已退出。19:24:09为running／auto、30秒间隔，恢复后两轮completed且error空，第三轮当时running，公开／私信采集正常；额度与原08:00–23:30时段恢复。账号三项confirmed／confirmed／off，但资源随内存波动仍attention，按正常安全边界处理；health缓存businessBlocked=false不证明临界新业务准入，旧unknown及私信prepare保护保留，不强制绕过恢复。最终截图及精确证据见0.1.28.7记录，不称全局全绿。

- 0.1.28.2历史发布与私信验收快照：运行源码bd489e0基于0.1.28.1／a0dba43。全套720项、独立真实平台读回及四条前文实际上下文通过，当次私信仅发送一条；两次模型请求估算$0.0008244，峰价保守$0.0025896。当时恢复running／auto、时效3小时，旧公开unknown保留；当时Other来源unverified单独待验证，后续结果见最新实施记录。详见docs/发布记录/2026-10-30-0.1.28.2.md。所有构建和测试使用dev/server-heavy.sh的共享锁、640MiB硬限额、无额外swap和单CPU，不并发重任务。浏览器仅替换同源dist，不升级内核或混入未发布安全候选；保留profile、journal和旧unknown。

- 需求、架构和跨模块变更采用 OpenSpec，先阅读 `openspec/README.md` 与 `openspec/config.yaml`。
- 七页生产基线提案为 `openspec/changes/add-seven-page-production-bot/`；按 `proposal.md`、完整增量规格、`design.md`、`tasks.md` 理解范围。旧七页计划保留为来源，后续修改同步到提案，避免两份设计分叉。
- `openspec/specs/` 只记录现有行为；尚未实现的需求保留在 change 的增量规格中，不能因规划完成就提前同步或归档。
- Codex 项目技能位于 `.agents/skills/openspec-*/`。提案整理与业务实施分别记录，任务只有完成验证后才能勾选。

- 0.1.27.1 历史发布快照：app／browser 为 **0.1.27.1**，schema 14，来源 `00e6016`，成对 healthy。新 Chat 可靠入站及请求处理已实现；实际只读取得五条消息和一个 Other 请求，接受与回复尚未执行。709 项单元、原生 DOM 六项、既有 Chat DOM 41 项、相关 UI 46 项通过；生产状态保持管理员最新 paused／auto，不能恢复旧 running。OpenSpec `complete-xchat-private-workflow` 的真实收发 3.3 仍留空，未同步主规格或归档。详见 `docs/发布记录/2026-10-30-0.1.27.1.md`。
- 0.1.26 发布时，正式 app／browser 为 0.1.26，schema 14；导航为动态、人设、设置三页。发布时恢复管理员原 running／auto，随后管理员多次接管、释放，目前为 paused／auto。每次操作读取实时状态，不用历史记录覆盖用户后续控制。已取得正式构建（693/693）、隔离全套 UI 验收、生产只读（8/8）和有限真实试聊证据；跨夜开放与既有平台收发边界看 README 和发布记录，不能把部署等同于所有真实业务验收。
- 本轮五项已部署功能为 `add-private-daily-limit`、`add-reply-hours`、`add-persona-workspace`、`redesign-settings-workspace`、`redesign-feed-workspace`。采用动态、人设、设置三页，人设库与独立正常流程试聊均按相应增量规格实现；一个试聊会话模拟一个用户，公开消息保留各自线程 ID，不跨线程合并。
- 新版界面总回归入口为 `dev/workspace-ui-test.sh`；保留原验收脚本的业务断言，迁移到新位置，不能以新冒烟用例取代原覆盖。真实模型效果与生产发布需要独立证据，未满足的任务继续留空。
- 后续提案隔离验证使用 `dev/proposals-sync.sh` 与 `dev/proposals-test.sh`，目标为 `/srv/role-workflow-proposals`，不得覆盖已有七页开发副本或生产目录。验收结束清理本轮临时容器、镜像与工作目录，保留最终证据。

- 设置与记忆细节、人设本地 JSON 导入导出已随 0.1.20 发布。跨渠道召回只走显式关联，公开仅拿私信长期背景并执行八字重合草稿保护；试聊自动关联。PLATFORM_IDENTITY_LINKS 保持 false，真实样本任务未完成；本轮38次真实模型调用共用1美元预算，费用与适用边界看本轮发布记录。

- 0.1.21 已发布原生 read_card→submit_draft、模型参数精简与同文重复降优先。沿用目录稳定前缀、20次执行上限、逐轮计量及暂停／unknown保护。0.1.22 已发布试聊与动态前端排版，十八套192组和生产只读8项通过，无新增模型调用；保留工具草稿、读取详情及0.1.21成对镜像回退。

# 提交署名

Codex 参与编写的提交保留维护者的作者与提交者身份，并在提交说明末尾添加共同作者署名：`Co-Authored-By: Codex <codex@openai.com>`。

- 设置页草图返修已随 0.1.25.1 发布，来源 293de2d；生产只读 9/9、120 张截图通过。真实任务种类多时历史筛选必须换行；主区无横向溢出，宽表只在组件内滚动。

- 0.1.26 已发布人设目录编辑及侧栏稳定节点、调用流水原位展开、操作提示自动收起与日志徽标跨列修复；693 项单元、十二套累计 126 项 UI、生产只读 11/11 通过。真实私信会话尚未采集成功，不能将 UI 发布当作新 Chat 自动回复验证。
