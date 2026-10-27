# 单账号角色互动工作流

运行在服务器上的确定性消息工作流。仅处理 X 公开回复和私信，不主动发帖，不接入 Buffer。

## 代码仓库与当前版本

代码仓库：[blueforst/dafeiyu](https://github.com/blueforst/dafeiyu)。当前应用版本为 **0.1.14**，浏览器版本为 **0.1.12**：包含 Claude 面板与模型配置接口，浏览器固定使用 Camoufox，按浏览器当前登录账号工作。服务保持暂停、草稿模式。已补齐 OpenCode 会话头，正式回复默认上限调整为 4096 token，见 [0.1.14 发布记录](docs/修复记录/2026-10-27-opencode-session.md)。供应商目录完整列出 pi 内置服务商，并额外提供 Command Code 预设。

仓库包含源码、配置示例、部署文件及 `dev/` 下的开发验收脚本。实际 `.env`、入口密码、模型 Key、浏览器 profile、数据库和本机交付资料保留在运行环境中。

`dev/sync.sh` 把本机源码同步到服务器开发副本；`dev/t.sh`、`dev/e2e.sh` 在该副本运行测试，`dev/staging-up.sh` 在服务器启动独立 staging，`dev/prod-accept.sh` 执行暂停状态下的生产验收。脚本使用本机 SSH 别名 `dsh`，服务器目录沿用下文约定；staging 的配置、凭据与数据需独立准备。

## 当前交付边界

代码、模拟接口测试和浏览器桌面可先独立验收。真实账号登录、模型凭据、当前 X 私信 DOM 适配、指定会话收发及 12 小时业务草稿观察必须分别记录。页面能访问、容器 healthy 或模拟测试通过，不代表真实收发验收完成。

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
- `app/panel/settings.json`：面板保存的模型设置，优先于 `config.json` 的对应字段。
- `app/panel/model-keys.json`：面板保存的模型 Key，按"服务商@接口主机"分别存放，权限 0600；面板和日志只显示末 4 位。
- `secrets/app/model_api_key`：旧方式的模型密钥，只在面板从未保存过模型时使用。
- `app/workflow.sqlite`：队列、记忆、回执和日志。
- `app/forget-ledger.json`：独立遗忘记录，恢复旧数据库后自动重放，不能随旧备份覆盖。
- `browser/`：登录状态和浏览器发送日志。
- `admin-access.txt`：管理入口及密码，仅管理员可读。

代码库和镜像均不包含真实配置、密钥或账号数据。

## 首次配置

1. 打开 HTTPS 面板，用交付资料中的凭据登录。面板分"概览 / 模型 / 浏览器"三页，右上角是运行状态和"恢复处理 / 暂停"。
2. 在"浏览器"页点"接管并连接"，由账号所有者完成 X 登录、验证码及私信解锁，然后点右上角"释放接管"。浏览器页平时不连接。
3. "概览"页显示浏览器当前登录的账号，工作流直接使用此账号，无需另外配置。运行模式仍在 `config.json` 里设置，保持 `mode: "draft"`。
4. 在"模型"页选择服务商：pi 内置服务商会自动带出 Base URL、协议、上下文长度和推理档位；中转站或自建服务选"自定义"，填 Base URL 并选择协议。填写 API Key，可以"用 Key 拉取"接口上的模型列表，然后"测试连接"（会产生少量费用），最后"保存"。
5. 点右上角"恢复处理"。需要浏览器已登录并完成人工验证；处理期间退出登录或切换账号会暂停，检查后可重新恢复。

面板保存的设置和配置文件都在每轮重新读取，不用重启或重建镜像。Pi 上游包为 `@earendil-works/pi-ai@1.4.0`。当前面板使用 API Key 或 API Token，不提供订阅账号登录流程。pi 的所有内置服务商均列出；需要额外参数或认证流程而尚未接入的条目显示具体原因，不能误选。OpenCode Zen/Go 和 Radius 使用模型级地址；Command Code 额外使用官方 Provider API 目录，Claude 走 Messages，其他聊天模型走兼容接口。Base URL 不能指向本机、内部服务或云元数据地址。

面板设置和 Key 存在 `app/panel/`，**不进入**数据库备份；从备份恢复后需要在面板上重新填写 Key。

新建模型的回复长度上限默认为 4096 token，可在 64–8192 范围内调整，且受模型自身输出上限约束；启用推理时另加推理预算。连接测试使用最小请求，不受正式回复默认值影响。

视觉输入尚未接入：图片会显式标记为不可见，禁止模型猜测。配置中的 vision 目前保持 false。

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

真实账号身份、模型请求、公开消息及私信读取分别通过验收；完成至少 12 小时业务草稿观察；用户指定测试会话，确认真实回复和回执；之后由管理员把运行模式改为 auto。

业务草稿观察时间从第一条真实生成的草稿开始记录。基础设施空载运行不计入业务观察。当前业务观察是否开始，以面板和验收记录为准。

## 升级和回滚

先在服务器构建和测试新镜像。升级脚本暂停业务、停止浏览器后切换版本，升级后保持暂停。按用户要求，不自动创建源码、数据库或 profile 备份，不保留旧镜像；源码由 Git 管理。

```sh
sh deploy/upgrade.sh 新版本号
sh deploy/rollback.sh 已重新构建的版本号
```

本期数据库结构为初始版本；未来不兼容迁移必须记录版本并恢复配套旧备份，禁止让旧程序读取不兼容数据。恢复数据库前停止 app，保留当前 forget-ledger.json，再用备份替换数据库并移走对应 WAL/SHM；启动时自动重放遗忘记录。

生产验收后可执行 `sh deploy/cleanup.sh`，回收本项目未使用的旧镜像、历史打包备份和 Docker 未使用构建缓存。运行中的容器镜像会保留。

## 监控和证书

宿主 systemd 管理容器开机启动、每五分钟健康检查和每小时证书续期检查。按用户要求停止本项目的自动备份。监控写入 `monitor-latest.json` 及 systemd journal，本期没有配置外部邮件或聊天通知。

IP 证书约六天有效，必须保留 HTTP-01 验证入口及自动续期任务。续期成功后执行 nginx -t 并 reload；续期演练和实际证书有效期单独留证。

## 测试与构建

构建和测试只在服务器运行。Docker builder 执行类型检查和安全回归；另有 Camoufox DOM 样本解析与公网面板/noVNC 端到端验收。公网面板验收（`test/ui-acceptance.mjs`）只在处理暂停时执行：它会接管一次浏览器以确认桌面可用，结束后释放；处理运行中则直接跳过（退出码 2），不做任何操作。

```sh
docker build --target runtime -t role-workflow-app:版本号 .
docker build --target browser -t role-workflow-browser:版本号 .
```

## 来源与限制

浏览器桌面分层参考 runzhliu/deepseek-harness-docker 的提交 833d60e772635a13c799c296730428c984312e58，自行实现生命周期和应用接口，不安装 DSH。seccomp 配置参考 microsoft/playwright v1.64.1；Pi AI 来源 badlogic/pi-mono。第三方软件许可证保留在对应包和镜像中。

X 当前规则禁止网页脚本自动化，并要求 AI 自动回复事先取得平台明确书面批准；技术运行成功不构成平台许可。
