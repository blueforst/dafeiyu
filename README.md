> 本轮新增五页面板及六项后续提案候选，尚未生产发布。下文七页首次配置属于 0.1.16 基线；候选使用方式见 [后续提案实施说明](docs/后续提案实施.md)，验证进度见 [实施记录](docs/实施记录/2026-10-28-后续提案.md)。推送源码不会自动部署或恢复业务。

# 单账号角色互动工作流

运行在服务器上的确定性消息工作流，处理 X 公开回复和私信，不接入 Buffer。七页面板与初始关闭的早晚安计划已部署，当前业务保持暂停、草稿模式。

## 代码仓库与当前版本

代码仓库：[blueforst/dafeiyu](https://github.com/blueforst/dafeiyu)。当前应用版本 **0.1.16**、浏览器 **0.1.15**，七页面板、模型计量、人设、记忆和任务管理已上线，见 [0.1.15 发布记录](docs/发布记录/2026-10-28-0.1.15.md)；日志已从主页面移到主程序，见 [0.1.16 发布记录](docs/发布记录/2026-10-28-0.1.16.md)。浏览器沿用原 0.1.12 的 Camoufox 环境与原登录 profile，服务保持暂停、草稿模式。OpenCode 会话兼容及正式回复默认 4096 token 继续保留；供应商目录包含 Pi 内置服务商与 Command Code 预设。

仓库包含源码、配置示例、部署文件及 `dev/` 下的开发验收脚本。实际 `.env`、入口密码、模型 Key、浏览器 profile、数据库和本机交付资料保留在运行环境中。

`dev/sync.sh`、`dev/t.sh`、`dev/e2e.sh` 对应原面板开发副本；七页实现使用独立 `dev/seven-sync.sh`、`dev/seven-test.sh`。生产七页验收使用 `test/production-seven-pages.mjs`，不再使用旧三页验收脚本。SSH 别名为 `dsh`，staging 配置、凭据和数据独立准备。

## 当前交付边界

七页代码已按 [OpenSpec 提案](openspec/changes/add-seven-page-production-bot/proposal.md) 部署。项目使用方法见 [OpenSpec 说明](openspec/README.md)；真实模型与 X 平台的读取、发送和双方回执仍按 [实施任务](openspec/changes/add-seven-page-production-bot/tasks.md) 单独验收，尚未因部署而完成。

代码、模拟接口测试和浏览器桌面可先独立验收。真实账号登录、模型凭据、当前 X 私信 DOM 适配、指定会话收发及 12 小时业务草稿观察必须分别记录。页面能访问、容器 healthy 或模拟测试通过，不代表真实收发验收完成。

## 七页实现状态与入口

以下七页入口与新增 API 已上线，日志集中在主程序页。发布前完成独立 staging 验收，发布后完成真实公网页面与接管检查；本轮没有真实模型调用或 X 收发。完成情况以 [实施任务](openspec/changes/add-seven-page-production-bot/tasks.md) 和发布证据为准。

| 页面 | 地址 | 职责 |
| --- | --- | --- |
| 主页面 | `#/overview` | 状态、账号、日志概览与浏览器接管区 |
| 模型 | `#/model` | 服务商、模型、Key、连接测试 |
| 人设 | `#/persona` | 静态分区、语义触发、多轮试聊与虚构日程内容 |
| 记忆 | `#/memory` | 策略、用户／会话、来源条目、遗忘与只读召回 |
| 主程序 | `#/program` | 阶段、队列、运行设置、额度与日志 |
| 定时任务 | `#/tasks` | 主循环间隔、业务及宿主计划、单次执行和历史 |
| 计费 | `#/billing` | 北京时间范围、Pi 成本估算、趋势与调用流水 |

默认进入主页面；旧 `#/browser` 转到主页面并展开接管区，展开不自动连接桌面。日程内容在人设页，计划只在任务页维护；保存任何配置不会隐式恢复处理。任务页的主循环启停是显式全局控制操作。早晚安与备份初始关闭，日程 06:00、记忆补整理 03:00 初始启用，但暂停或接管期间不会自动进行业务模型调用。

实现与接口说明：[七页面板](docs/七页面板.md)、[前端接口](docs/前端接口.md)、[人设与日程](docs/人设与日程.md)、[记忆策略](docs/记忆策略.md)、[模型计量](docs/模型计量.md)、[出站与回执](docs/出站与回执.md)、[任务与宿主维护](docs/任务与宿主维护.md)、[宿主维护桥接](docs/宿主维护桥接.md)、[迁移与恢复](docs/迁移与恢复.md)。

## 架构

宿主 Nginx 提供 HTTPS 与密码认证。业务容器为 TypeScript / Fastify / SQLite；浏览器容器为 Camoufox / Xvfb / Openbox / x11vnc / noVNC。Pi AI 负责模型协议适配。

- 仅 `127.0.0.1:8080` 发布宿主端口；浏览器内部 API、VNC、CDP 不暴露公网。
- 浏览器使用非 root、只读根目录、capabilities 清空及 seccomp 限制，不使用 privileged，不挂载 Docker socket。
- 浏览器 profile 由文件锁保护，崩溃遗留的 Firefox 锁只能在拿到独占锁后清理。
- 程序启动保持暂停；人工接管前排空当前操作，释放时关闭 VNC 客户端并继续暂停。
- 可选的 [X 浏览器专用出口](docs/X浏览器代理.md) 通过内部 Mihomo 服务接入固定节点，独立于宿主网络设置。
- 当前生产浏览器使用服务器直连；Bitz 节点已按用户要求移除。
- 业务浏览器固定使用 Camoufox，已移除 Chromium 及构建选择；见 [Camoufox 浏览器](docs/Camoufox浏览器.md)。

## 目录

服务器代码：`/srv/role-workflow`。持久数据：`/var/lib/role-workflow`。

- `config/config.json`：角色、限速、运行模式，以及面板未设置时使用的模型。
- `app/panel/settings.json`：保存模型、人设、任务、记忆和程序设置及各域修订，优先于 `config.json` 的对应字段。
- `app/panel/model-keys.json`：面板保存的模型 Key，按"服务商@接口主机"分别存放，权限 0600；面板和日志只显示末 4 位。
- `secrets/app/model_api_key`：旧方式的模型密钥，只在面板从未保存过模型时使用。
- `app/workflow.sqlite`：队列、记忆、回执、日志、迁移版本、调用流水、日程修订、来源条目、outbox、任务历史及阶段。
- `app/forget-ledger.json`：独立遗忘开关，恢复旧数据库后自动重放，不能随旧备份覆盖。
- `app/forget-history.json`、`app/forgotten-sources.json`、`app/memory-mutations.json`：遗忘／恢复边界、已忘来源与人工删除记录；恢复数据库必须保留当前文件，防止旧数据或再次采集使内容复活。
- `browser/`：登录状态和浏览器发送日志。
- `admin-access.txt`：管理入口及密码，仅管理员可读。

代码库和镜像均不包含真实配置、密钥或账号数据。

## 首次配置

1. 打开 HTTPS 面板，用交付资料中的凭据登录。面板提供七个一级页面，右上角是运行状态和“恢复处理／暂停”。
2. 在主页面展开“浏览器接管”，点“接管并连接”，由账号所有者完成 X 登录、验证码及私信解锁，然后点右上角“释放接管”。平时按需连接。
3. 主页面显示浏览器当前登录账号，工作流直接使用此账号，无需另外配置。运行模式在主程序页设置，初始保持草稿。
4. 在"模型"页选择服务商：pi 内置服务商会自动带出 Base URL、协议、上下文长度和推理档位；中转站或自建服务选"自定义"，填 Base URL 并选择协议。填写 API Key，可以"用 Key 拉取"接口上的模型列表，然后"测试连接"（会产生少量费用），最后"保存"。
5. 点右上角"恢复处理"。需要浏览器已登录并完成人工验证；处理期间退出登录或切换账号会暂停，检查后可重新恢复。

面板保存的设置和配置文件都在每轮重新读取，不用重启或重建镜像。Pi 上游包为 `@earendil-works/pi-ai@1.4.0`。当前面板使用 API Key 或 API Token，不提供订阅账号登录流程。pi 的所有内置服务商均列出；需要额外参数或认证流程而尚未接入的条目显示具体原因，不能误选。OpenCode Zen/Go 和 Radius 使用模型级地址；Command Code 额外使用官方 Provider API 目录，Claude 走 Messages，其他聊天模型走兼容接口。Base URL 不能指向本机、内部服务或云元数据地址。

面板设置和 Key 存在 `app/panel/`，**不进入**数据库备份；从备份恢复后需要在面板上重新填写 Key。

新建模型的回复长度上限默认为 4096 token，可在 64–8192 范围内调整，且受模型自身输出上限约束；启用推理时另加推理预算。连接测试使用最小请求，不受正式回复默认值影响。

视觉输入尚未接入：图片会显式标记为不可见，禁止模型猜测。配置中的 vision 目前保持 false。

## 七页功能配置与独立 staging

1. 确认使用独立开发目录、配置、凭据与数据，未挂载生产浏览器 profile；开发同步使用 `dev/seven-sync.sh`，构建和回归使用服务器上的 `dev/seven-test.sh`。既有 `dev/sync.sh` 对应原面板开发副本，不用于覆盖本次独立目录。
2. 在主页面展开浏览器接管区，通过“接管并连接”完成独立测试环境的账号检查。释放后保持暂停；模拟验收不借用生产登录态。
3. 在模型页配置与保存模型，按需要明确发起连接测试。测试、CLI、试聊、日程和记忆整理都会写同一调用流水；测试可能收费，未返回可靠用量或价格时显示未知／未定价。正式回复上限默认仍为 4096 token。
4. 在人设页检查旧人格原文、编辑静态分区和触发规则；可用未保存稿进行公开或私信多轮试聊。试聊使用模拟记忆，不向 X 发送，也不写生产记忆。日程明确标为虚构；编辑或重新生成由管理员明确发起，内容与真实经历分层。
5. 在记忆页检查最近三次／七天、原文三十天的默认策略。来源不完整的旧摘要保留在未知账号范围，不自动迁给当前账号。遗忘后恢复只允许可靠的新消息，已忘来源及旧库内容不得复活。
6. 在主程序页检查运行模式、时效、每轮数量和额度；在任务页设置主循环间隔及计划。保留早晚安和备份关闭，确认宿主桥接真实安装状态。保存计划不会恢复业务；“单次执行”日程／记忆是明确模型调用，问候帖仍受模式、窗口、额度和回执约束。
7. 查看计费页的已知 token、Pi 目录估算和未知项。按 [实施任务](openspec/changes/add-seven-page-production-bot/tasks.md) 完成独立集成、迁移回退及后续发布和真实验收，再执行生产控制操作；staging 测试不能替代这些证据。

七页配置按域修订合并，过期保存返回冲突；当前生成使用原快照，下轮再读新设置。数据库备份只含业务 SQLite，保留七份；不含面板配置、Key、源码、浏览器 profile 或独立遗忘／删除账本。恢复时分别准备配置、凭据和当前账本，详见 [迁移与恢复](docs/迁移与恢复.md)。

## 日常命令

所有命令在服务器执行：

```sh
cd /srv/role-workflow
docker compose ps
docker compose logs --tail 100 app browser
docker compose exec -T app node dist/cli.js status
docker compose exec -T app node dist/cli.js drafts
docker compose exec -T app node dist/cli.js model-check
docker compose exec -T app node dist/cli.js retry '消息ID'
docker compose exec -T app node dist/cli.js forget '用户ID'
docker compose exec -T app node dist/cli.js remember '用户ID'
docker compose exec -T app node dist/cli.js backup
```

`model-check` 会发起一次真实模型请求，可能计费。`drafts` 包含消息正文，只在管理员终端查看，不应复制到公开日志。

## 消息与记忆

- 采集来源轮换：提及、搜索、自己帖子下面的回复；每轮最多查看三个私信会话。
- 私信按会话独立记忆，公开记忆不会读取私信。当前没有自动跨渠道用户身份合并。
- 最近三次原文作为短期上下文；每累计五条新记录，按公开/私信分别整理摘要。
- 忘记指令会清理消息和摘要、增加记忆代次，并停止后续记录。正在生成的旧摘要不能重新写回。
- 默认保留原始消息 30 天。手动数据库备份保留最近七份；升级不自动备份。遗忘元数据独立保存，恢复时继续生效。
- 模型输出只接受 reply/skip 结构，发送前校验链接、额外 @ 和公开回复的加权字符长度。

## 发送与恢复

发送状态：queued → generating → draft → sending → confirmed / unknown / failed。

初次运行仅生成草稿。开启自动模式不会自动发送旧草稿；确需重处理时使用 retry。发送超时或无唯一消息 ID 时进入 unknown，只回查，不重发。存在 unknown 的通道暂停新发送，需要管理员核对。

每小时默认公开回复 10 条、私信 30 条，每轮最多两条。平台拒绝后对应通道退避四小时。以上是内部额度，不是平台许可。

X 页面可能变化；遇到不识别的输入框、聊天方向或回执时停止该项操作并记录异常。新版加密 Chat 需要使用真实账号验证后按实际 DOM 适配，不能把模拟解析测试当作真实私信验收。

## 自动回复启用条件

按当前 OpenSpec 提案分别验证真实账号身份、模型请求、公开消息与私信读取，再在明确授权的测试帖和会话中确认真实回复及双方回执；之后才按授权保持正常 auto。页面可用或基础设施空载观察不能替代真实业务验收。

业务草稿观察时间从第一条真实生成的草稿开始记录。基础设施空载运行不计入业务观察。当前业务观察是否开始，以面板和验收记录为准。

## 升级和回滚

先在服务器构建和测试新镜像。升级脚本暂停业务、停止浏览器后切换版本，升级后保持暂停。按用户要求，不自动创建源码、数据库或 profile 备份，不保留旧镜像；源码由 Git 管理。

```sh
sh deploy/upgrade.sh 新版本号
sh deploy/rollback.sh 已重新构建的版本号
```

生产已使用版本 1—7 的迁移、账号归属及摘要复合主键；`deploy/rollback.sh` 会拒绝对新库执行通用镜像回退。初始空载窗口的受限逆迁移已演练并在部署时通过只读资格检查，接通宿主历史后该窗口关闭。恢复前暂停并排空、停止 app，保留独立遗忘／删除账本，使用另行验证的转换或配套恢复；不能删有效数据绕过门禁。详见 [迁移与恢复](docs/迁移与恢复.md)。

生产验收后可执行 `sh deploy/cleanup.sh`，回收本项目未使用的旧镜像、历史打包备份和 Docker 未使用构建缓存。运行中的容器镜像会保留。

## 监控和证书

宿主 systemd 管理容器开机启动、每五分钟健康检查和每小时证书续期检查。按用户要求停止本项目的自动备份。监控写入 `monitor-latest.json` 及 systemd journal，本期没有配置外部邮件或聊天通知。

IP 证书约六天有效，必须保留 HTTP-01 验证入口及自动续期任务。续期成功后执行 nginx -t 并 reload；续期演练和实际证书有效期单独留证。

## 测试与构建

构建和测试只在服务器运行，生产七页基线 165 项、本轮候选 325 项通过。公网七页验收使用 `test/production-seven-pages.mjs`：只读接口和页面，暂停时临时接管并释放以检查 noVNC；不调用模型、不改配置、不操作 X 内容。初始已人工接管时只观察，不释放他人的会话。

七页工作树在 `/srv/role-workflow-seven` 和 `/var/lib/role-workflow-seven` 使用独立源码、数据与验收产物。`dev/seven-sync.sh` 排除真实配置、密钥、数据与生产 profile；`dev/seven-test.sh` 在服务器构建 builder 并执行类型检查与自动回归。七页浅／深色、375px、空／错误状态与编辑保护使用 `test/seven-pages-acceptance.mjs`，模型 mock、Camoufox DOM、真实上游和平台发送分别留证。宿主桥接安装步骤见 [宿主维护桥接](docs/宿主维护桥接.md)，不能把请求已写入当作维护已完成。

```sh
docker build --target runtime -t role-workflow-app:版本号 .
docker build --target browser -t role-workflow-browser:版本号 .
```

## 来源与限制

浏览器桌面分层参考 runzhliu/deepseek-harness-docker 的提交 833d60e772635a13c799c296730428c984312e58，自行实现生命周期和应用接口，不安装 DSH。seccomp 配置参考 microsoft/playwright v1.64.1；Pi AI 来源 badlogic/pi-mono。第三方软件许可证保留在对应包和镜像中。

X 当前规则禁止网页脚本自动化，并要求 AI 自动回复事先取得平台明确书面批准；技术运行成功不构成平台许可。
