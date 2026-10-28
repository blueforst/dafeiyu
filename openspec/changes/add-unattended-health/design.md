# 无人值守健康技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [runtime-health](specs/runtime-health/spec.md) 与 [account-compliance](specs/account-compliance/spec.md)。

- `Workflow.start()` 用 `setTimeout` 链驱动 `tick()`，`busy` 标志防并发；`tick()` 没有整轮超时，只靠各浏览器步骤的 Playwright 超时（导航 30 秒、等待 10–15 秒）和模型 `timeoutMs`（最长 180 秒）。`waitIdle()` 等待最长 100 秒。
- 浏览器服务（`src/browser.ts`）用 `Serial` 串行化所有操作，用 `launchBrowser()` 启动持久化 profile 的 Camoufox 上下文；容器 `mem_limit: 2g`，没有内存检查或重启逻辑。`Identity` 只有 `loggedIn`、`needsHuman`，识别验证码与解锁提示，不识别冻结或只读。发送结果对 toast 中的 “limit|automated|…” 统一视为拒绝并四小时冷却。
- `deploy/monitor.py` 由 `role-monitor.timer` 每五分钟运行，读取 `/api/status`，检查 `lastTick` 超过二十分钟、冷却、容器与证书，写 `monitor-latest.json`，有问题时打印到 journal。宿主维护桥接只接受 `backup`、`health` 两类任务。
- 七页提案的任务调度已有任务实例、历史和北京时间计划，可承载新任务。

## Goals / Non-Goals

**目标：** 所有超时、自愈与指标都在现有进程内完成，不依赖新服务；健康结果有一个计算来源，被面板、日报和宿主监控共同读取；账号检查严格只读。

**非目标：** 不接入任何外部推送；不新增宿主维护任务类型；不自动修改账号资料、标签或设置；不做多账号或代理轮换；不用模型生成日报。

## Decisions

### 1. 轮次超时与采集预算

`tick()` 内创建轮次计时器：软超时默认 8 分钟（范围 3–30），到达后设置 `softExpired`，消息循环在开始下一条前检查；硬超时默认 12 分钟（范围软超时 + 2 至 45），到达后调用现有 `abort.abort()`。现有中止路径已把 `generating` 恢复为 `queued`、把阶段收束为 aborted，发送路径对异常记 unknown，因此硬超时复用同一路径。

浏览器 RPC 增加请求级超时（默认 120 秒）并把 `AbortSignal` 传给 `fetch`；浏览器服务侧在 `Serial` 中为每项任务设置上限，超时后关闭当前页面并重开，避免卡住的页面阻塞后续操作。采集函数接收 `deadline`，按来源与会话循环时检查，超时返回已采集结果与警告。公开、私信默认各 90 秒。

### 2. 看门狗

app 内 `setInterval` 每 60 秒检查：`control==='running'` 且 `busy` 持续超过 `hardTimeout + 120s`，或 `!busy && !timer && !stopped`。前者再次 `abort()` 并在 30 秒后检查是否释放；后者重新 `start()`。两次恢复失败调用 `safetyPause()`。看门狗本身只读写内存状态与日志，不调用浏览器。

### 3. 浏览器资源自愈

浏览器服务在 `Serial` 每项任务开始前只读采样 cgroup v2 的 `memory.current`、`memory.max` 与 `memory.stat`，以 current 减 inactive_file 的工作集判定并保留原始读数；读取失败时回退为遍历 `/proc` 统计 Camoufox 进程树 RSS。超过阈值（默认 75%）或上下文运行超过 24 小时先标记待恢复，满足下述持续压力、安全边界与保护条件后才关闭上下文并用同一 profile 重新 `launchBrowser()`，随后有界等待同账号身份就绪；结果写入浏览器日志并通过 `/health` RPC 暴露最近一次重启时间、原因与当前占用。重启失败或身份变化时向 app 返回明确错误，app 走 `safetyPause()`。

实施补充（2026-10-28）：正常页面工作集会在恢复后重新加载，瞬时越过 75% 不能直接导致每轮关闭。维持阈值不变，内存压力须持续三十秒且至少两个间隔样本；实际恢复仅允许 `prepare-round` 显式安全边界。已解锁／正在解锁 Chat、人工处理和未收束出站受保护；未收束出站挡住恢复时本轮只回查。恢复后五分钟内再现持续压力或滚动一小时超过两次恢复预算时，明确暂停且不再重启；受保护会话持续 95% 时暂停但不关闭。记录恢复前后 working set、延后原因与保护标记，不能把工作负载增长直接称为泄漏。

*备选*：由宿主 helper 重启整个浏览器容器。会中断 noVNC 和正在进行的操作，且需要扩展宿主白名单，被否决；容器级重启仍由 compose `restart` 策略兜底。

### 4. 健康计算与告警

新增 `src/unattended-health.ts` 与 `src/collection-health.ts`，函数 `evaluate(now)` 从现有数据计算指标：

| 指标 | 来源 | 异常条件（默认） |
| --- | --- | --- |
| 成功发送停滞 | 最近 `confirmed` 出站时间、可发送通道中 `queued` 数量、控制状态、模式 | 运行、自动、有可发送消息且 20 分钟无确认 |
| 连续失败轮次 | 主循环历史 | 连续 3 轮 failed |
| 平台拒绝与退避 | 冷却键、自动化拦截计数 | 退避中为注意；24 小时三次自动化拦截为异常 |
| 浏览器需人工处理 | `identity.needsHuman` | 异常 |
| 账号受限 | 账号状态（见第 5 节） | 异常 |
| 采集连续异常 | 按账号／渠道绑定的 `collection-result` | 同渠道真实失败或未适配连续 3 个独立轮次 |
| 备份失败 | 宿主 `backup-latest.json` | 最近一次失败 |
| 证书临期 | 宿主监控结果 | 少于 24 小时 |

迁移新增 `alerts(id, key, level, summary, started_at, last_seen_at, resolved_at)`，`key` 唯一约束活动告警（`resolved_at IS NULL`）。`evaluate` 在每轮结束和看门狗周期中执行，开启、刷新、恢复告警。`GET /api/health` 返回指标与活动告警，`/api/status` 增加 `health` 摘要；SSE 增加 `health` 事件。主页面（或动态首页顶部）显示活动告警横幅，任务页／排查区显示历史。

“成功发送停滞”与 `add-reply-triage` 的“可发送通道”使用同一判断函数；该提案尚未实施时退化为“冷却未过且小时额度未满”。

实施补充：浏览器保留 events／warnings 兼容，另返回固定码 diagnostics；账号、轮次、时间由应用绑定。公开和私信独立判定，同轮多来源只算一轮，预算 partial 不当全部失败；有真实失败来源的 partial 仍计失败，empty 必须有明确空界面证据。旧 warning 只显示范围未知注意，后续两渠道都有可信诊断时正常收束旧笼统告警，不掩盖仍存在的私信失败。

### 5. 账号状态识别

浏览器在身份检查、导航后和发送结果中匹配受限特征：页面文本（冻结、已被冻结、只读、受限、your account is suspended／locked／restricted／read-only 等）、`/account/access` 等跳转地址，以及对应 `data-testid`。具体选择器以实施时采集的脱敏页面样本为准，不凭猜测扩充。`Identity` 增加 `restricted?: 'suspended'|'locked'|'read_only'|'limited'`；app 发现后 `safetyPause()` 并开启告警。发送 toast 中“看起来像自动产生”与“已达上限”分开识别：前者计入自动化拦截计数，后者仍按现有拒绝处理。

### 6. 合规检查

新增浏览器 RPC `/compliance`：在串行控制内导航到自己的资料页读取名称、简介与自动化标签，再导航到通知设置读取质量过滤开关，返回结构化结果与“无法确认”原因；不点击任何会修改状态的控件。app 侧新增任务 `account-check`（默认北京时间 10:00、启用），只在运行且非接管时由调度器执行；暂停时允许管理员手动执行。结果存入 `runtime` 键并显示在主页面账号区。披露词在面板设置 `compliance.requiredPhrases` 中配置，默认 `["AI"]`。

### 7. 每日日报

新增任务 `daily-report`（默认 09:00、启用、不调用模型）。日报从 `messages`、`outbox`、`llm_calls`、`alerts`、主循环历史、控制状态日志汇总前一北京自然日数据，写入 `daily_reports(date PRIMARY KEY, created_at, body_json)`；`INSERT OR IGNORE` 保证同日只生成一次。启动时若当天 09:00 已过且无前一日日报则补生成一次。响应延迟为入站平台时间到确认发送的中位数与 P90，只统计可靠时间。缓存读取占比 = `cacheRead / (input + cacheRead)`，按返回 usage 的调用计算，没有 usage 的调用单列。面板提供近三十天列表与单日详情。

### 8. 宿主监控

`monitor.py` 增加读取 `/api/health`，把活动告警与指标写入 `monitor-latest.json`；保留现有容器、证书、可达性检查作为独立判断，app 不可达时沿用上一次告警快照并标注时间。保留 `lastTick` 检查作为兜底。

## Risks / Trade-offs

- [硬超时中止发送中的操作] → 发送路径已持久化提交意图，中止后进入 unknown 只回查，不会重发。
- [重启浏览器丢失页面状态或登录] → 使用持久化 profile；重启后先确认身份，失败即暂停。
- [cgroup 文件在不同宿主上不可用] → 回退为进程树 RSS；都不可用时只按运行时长重启，并在健康页显示“无法读取内存”。
- [受限识别误判导致暂停] → 只在明确文本或跳转匹配时触发，样本回归覆盖；暂停后管理员可检查并恢复。
- [合规检查额外导航增加平台风险] → 每天一次、只读、走互斥，失败不重试。
- [没有外部推送，管理员不看面板时仍可能延迟发现] → 本轮按用户决定接受；告警结构为未来推送预留。

## Migration Plan

1. 迁移新增 `alerts`、`daily_reports` 表，可重复执行；新任务默认启用但不涉及发送或模型调用。
2. 先在服务器 staging 用可控时钟与故障注入验证超时、看门狗与自愈；浏览器重启在隔离浏览器 profile 中验证，不占用生产 profile。
3. 回退时旧版本忽略新表与新设置；`monitor.py` 读取健康接口失败时自动退回原检查。

## Verification

- 单元测试：各指标判定边界（含队列空、额度满、暂停不判停滞）、告警开启／去重／恢复、日报汇总与补生成、受限文本匹配样本。
- 集成测试：硬超时收束且不重复提交；看门狗恢复丢失定时器且不并发；内存阈值触发重启且发送中不重启；合规检查不触发写操作；宿主监控在 app 不可达时独立记录。
- 所有构建与测试在服务器隔离环境执行；真实账号的受限页面无法主动制造，以脱敏样本回归为准并在记录中说明。
