## Context

正式 0.1.28.2 的旧公开回复仍保留 unknown。`Workflow.channelWaitReason()` 对同账号同渠道的消息 unknown 及出站 submitting／unknown 一律阻塞，自动回复、批准稿和早晚安帖共用该判断；正常轮次仍先回查。历史记录说明原浏览器提交意图缺失、原测试目标已删除，因此无法据此证明原回复成功或未提交。

管理员已明确确认“封存并继续测试”，并授权使用已登录的 Ceyi 账号制造真实公开互动，跑通后删除本轮新增公开内容、保留私信。此授权覆盖旧讨论文档中的待决事项；永久精确封存是本提案新增语义，不能包装成原规则的无行为变化修复。跨帖同人上下文单独由 `add-cross-thread-public-context` 实现。

## Goals / Non-Goals

**Goals:**

- 以受鉴权、可审阅、可撤销的精确记录保存人工决定，只解除这一个旧项对其他公开新项的阻塞。
- 保留原状态、回执、冻结正文、目标、提交时间、journal、额度计数、回查和同来源唯一约束。
- 默认无审核即阻塞；新 unknown、不完整关联、损坏审核和冻结内容变化都阻塞。
- 使用 schema14 既有存储，回退旧版本即可恢复原通道阻塞。

**Non-Goals:**

- 不宣称旧发送成功或未发送，不重新提交旧项，不清空或迁移业务账本。
- 不支持无关联出站的 legacy 消息、独立帖子或私信封存，不新增前端审核界面。
- 不为测试绕过时段、身份、额度、退避、临界资源或平台回执；不改模型会话路由、输出上限、价格或浏览器内核。

## Decisions

### 精确对象及数据流

`UnknownReviews` 从当前工作账号读取指定 outbox，再按其 `source_id` 读取同账号 message。只有 public／reply、两行均 unknown、有原提交时间、冻结目标和非空正文，且 event、body、draft 与消息／出站归属及目标一致的完整一对可审核。不同账号不可读取为当前对象，状态冲突不自动修复。

管理 API 仅保存审核；恢复正常运行后，由 `hasBlockingUnknown(store, accountId, channel)` 对全部当前 unknown／submitting 集合逐项判断。消息与其出站归一为同一个精确审核对象，其他任何未审核阻塞项仍使整个通道等待。扫描阻塞集合不能套用回查的条数上限，防止后面的新 unknown 被漏掉。

### 两种指纹与并发控制

冻结指纹覆盖 outbox 的 ID、account、channel、kind、source、target、冻结 event／text、创建与提交时间、状态，以及 message 的 ID、account、channel、user、source_id／platform_id／target_id 原列、冻结 body／draft、创建时间和状态。legacy 空来源列可保留；非空 platform／target 必须与出站目标一致，非空 source 采集别名必须在同账号下只对应本消息，不能把采集别名强制等同于规范消息 ID。正文只参与哈希，不复制到审核记录。冻结指纹排除回查持续变化的 `updated_at`、未知原因和运行时校验结果；因此没有新证据的正常回查不会撤销封存。

审批快照 revision 额外涵盖两行的 `updated_at`、receipt、error／validation 及完整当前审核 KV 原值。预览后发生回查、状态收束、撤销或其他修改时，旧 revision 不能新建审批。事务内同步复核账号、paused／idle、对象关联及 revision，不在事务中调用异步服务。这样既阻止过时审批，也不把后台回查时间误作永久冻结内容。

### runtime KV 与永久封存

键为 `unknown-review-v1:` 加 `JSON.stringify([accountId, outboxId])`。值保存 version1、active／revoked、账号、public 渠道、出站和消息 ID、冻结 fingerprint、reviewedAt、可选 revokedAt、requestRevision 与 dataRevision。审核永久有效，没有到期或续期；只有精确原对象仍符合条件时才生效。

重复发送同一已完成请求只返回原结果，不改审核时间、不再写日志。撤销后旧审批请求不能重新激活；重新批准必须再次读取当前 revision 并明确确认。对象进入真实终态时审核不再适用；之后不能把它转用给新 outbox 或另一消息。冻结指纹变化同样不自动更新已有审核。

选择现有 runtime KV 而非新增表，是为了保留 schema14 与原稳定版本可回退性。未知版本、损坏 JSON 或结构异常均按阻塞处理，并拒绝用新审批静默覆盖损坏记录。

### 管理 API 与审计

| 方法与路径 | 输入／结果 |
| --- | --- |
| `GET /api/unknown-reviews` | 当前账号的可观察旧公开出站及审核状态列表 |
| `GET /api/outbox/:id/unknown-review` | 脱敏预览：归属、状态、submittedAt、reviewable／reason、fingerprint、revision、reviewed／reviewedAt／revokedAt |
| `POST /api/outbox/:id/unknown-review` | `{revision, confirmed:true, action:"allow-other-public-items"}` |
| `POST /api/outbox/:id/unknown-review/revoke` | `{revision, confirmed:true, action:"restore-public-block"}` |

路由沿用 ingress Key、非 GET 的 `X-Workflow-Control: 1` 和 Origin 校验。写入要求当前账号处于 paused，且工作流／调度器没有在途任务；manual、draining、running 或 busy 均拒绝。API 不自动暂停或恢复，不调用模型或平台。日志仅含操作、账号、渠道、关联 ID、fingerprint 和审核时间，不含正文、密钥或请求头。现有管理鉴权不能识别具体自然人，不将请求自报名称当作已认证身份。

### 统一门禁与原保护

工作流和健康可发送性共享审核后的 unknown 判断。现有 unknown 状态和数量仍可见，不能把“已封存”展示为“已发送”。`Workflow.reconcile()`、`Outbox.pendingUnknown()` 与浏览器 journal 回查原样保留；`prepare-round.unsettledOutbox` 仍识别旧项并保护会话。审核不能解除临界资源限制。

小时／每日计数、同来源唯一约束、正文冻结、unknown 重排／重写拒绝和浏览器重复请求只回查均不使用审核例外。自动回复、人工批准稿及早晚安帖仅在原有其他条件都通过后才能发送。

### 真实验收与清理

服务器先通过隔离回归、构建及回退演练，再发布来源清晰的成对 app／browser 小补丁。生产复核当前账号、控制、预算和旧项完整快照；通过正规 API 封存已确认的精确旧项，然后恢复用户要求的运行状态。

每轮真实样本登记双方账号、采集来源、目标平台 ID、入站 ID、模型 callId、outbox ID、唯一回执和独立平台读回。矩阵包含正常主动帖子、通知提及、搜索提及、自帖评论、同帖后续回复，以及依赖独立提案的跨帖同人上下文。不能以一次入队同时冒充三个来源均已验证，也不能用补录代替原生来源验收。

使用已授权 Ceyi 登录会话前先核对实际账号；主动帖子仍通过任务与 outbox，互动回复走正常采集／生成／发送。主循环间隔设置的 30 秒表示轮次后的等待间隔，不保证整轮在 30 秒内完成。模型请求统一计量，未知价格或预算余量不足时停止追加并保留已发生结果。

清理只操作本轮登记且已独立确认归属的新增公开帖和回复；按对应账号的正常平台界面删除，必要时受控接管并等待在途结束。删除后的平台内容与本地已确认提交账本分别记录，不修改业务出站为未发送，不删除旧 unknown、历史公开内容或私信。保留逐条删除结果，失败项明确列出。

## Risks / Trade-offs

- 人工封存并不能补足旧平台回执 → 旧项始终 unknown，保留其可见状态、原账本及正常回查。
- 永久记录会跨进程重启存在 → 只匹配精确冻结对象，支持明确撤销，不推广为账号或渠道许可。
- 回查与管理请求竞争 → 审批要求 paused／idle，事务内再次核对完整 revision；已经变化的请求返回冲突。
- 只接入部分发送入口会导致规则分叉 → 使用共享 helper 覆盖工作流、主动帖子和健康判断，额度及资源保护独立验证。
- 已授权测试可能留下公开内容 → 维护本轮精确新增清单，在完成后逐条核对并清理；删除不能代替发送回执证明。

## Migration Plan

1. 在服务器使用共享重任务锁、640MiB 上限、无额外 swap、单 CPU 串行运行相关与完整回归，保留失败历史和最终证据。
2. 记录实际生产版本、配置、旧未知项、profile／journal 与在途状态；暂停并排空后成对发布，不混入未发布安全候选或浏览器升级。
3. 通过受鉴权 API 读回，按已获授权保存精确封存，再执行真实矩阵和仅本轮公开内容清理；记录费用、最终控制及未完成边界。
4. 回退时暂停排空，成对恢复旧镜像，保留数据库与审核 KV。旧代码忽略审核 KV，原 unknown 自动重新阻塞；旧状态、额度和 journal 不需逆迁移。若之后重新部署支持审核的代码，仍只有该永久精确记录可能生效，不能声称回退已撤销审核；需要撤销时在支持版本走正式撤销 API 并读回。

## Open Questions

本次封存范围、永久性和可撤销性已获明确授权，没有以到期、续期或全渠道豁免替代该决定。真实矩阵中尚未观察到的页面来源、回执及清理结果属于实施验收，不预先判定通过；Other 私信来源的未验证边界继续留在原提案。
