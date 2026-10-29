# 新 Chat 只读适配与启用门槛

本文保留 0.1.26 及之前的观察契约说明。后续新增的 `xchat-native-v2`、请求接受与持久回查见[新 Chat 私信处理](新Chat私信处理.md)；下文“始终空 events”只适用于 `xchat-observation-v1`，不能用于描述新版可靠原生契约。

本次新增 `src/chat-dom.ts`，目标是让新 Chat 的原生结构可被可靠观察，并解释为何尚不能自动处理。它不修改平台内容，不点击请求接受／屏蔽，不生成消息时间、ID 或方向，不调用模型；新 Chat 分支始终返回空 `events`。原生消息观察结果在 `all`，可见摘要在 `observations`／`diagnostics`，不能把“自动事件为零”解释成没有私信。

## 已实现的只读边界

- 使用 Playwright locator 穿透 `[data-testid="xchatEmbedRoute"]` 的 open ShadowRoot。消息正文及 sender/time 的 ARIA 引用只在该消息所在 ShadowRoot 查找，且引用目标必须属于同一 row，排除 document 同名节点和跨消息引用。
- 原生 `data-dm-message-row` UUID、`message-{UUID}`、唯一 `[role="article"]` 的 `data-dm-message-focus-target="UUID:content"` 与 `message-text-{UUID}` 保持一致；缺失、冲突、重复 ID 对应不同内容或正文超过资源边界时明确给出诊断，不生成替代 ID。
- 正文只取已关联 content 内唯一 `span[dir="auto"]` 子树，不读取包含时间 overlay／opacity 占位的整个 content。缺失或多个正文候选保持未知；正文自身出现与显示时间相同的末尾字符串也原样保留，不通过剪裁尾部时间猜正文。
- 已观察到的原生 sender 引用值 `You` 只作为本账号出站观察信号。非 `You` 不自动反推入站，正文中的 `You` 也不能作为方向证据。未知最新消息不回退挑选较早消息回复。
- `Today`、`1:10 PM` 等只保存为原生显示标签。消息保持 `timestamp=0`、`timestampReliable=false`，不从 UUIDv4 推时间，不用采集时间或服务器时间填缺失平台时间。
- `/i/chat/requests`、`/i/chat/other` 是收件入口，不是会话 ID。仅导航页面实际提供的新 Chat 入口；一对一会话同时要求数字双参与者 href、父 div 上对应的 `dm-conversation-item-数字:数字`、anchor 自身 `dm-conversation-option-数字:数字` ID 和 `role="option"`，以及已识别的 Conversations listbox 四重绑定。入口缺失或结构不符给出具体诊断，不猜 URL，也不占用六会话扫描名额。
- 保留 legacy 可靠 ID、明确方向及原生 datetime 路径；字段不足不产生自动回复事件。采集按入口和会话去重、共享截止时间、有界扫描，并保留截止前已取得的结果。

## 集成接口

- `inspectPrivateConversation(page, conversationId, {needsHuman?})`：返回 `{contract, events, all, diagnostics, warnings, chatProtection}`；新 Chat 为 `xchat-observation-v1`，legacy 为 `legacy`。
- `discoverPrivateInboxes(page)`：区分实际观察到的收件入口和可定位会话，不执行点击或导航。
- `collectPrivateWithDiagnostics({page,handle,deadline,navigate,now?})`：依赖已有串行 `navigate`，返回 `events`、固定码诊断、无正文的会话摘要及保护状态。新 Chat 不自动进入业务队列。
- `chatProtection` 含 `hasUnlockedSession`、`unlockPending`、`needsHuman`，供工作流安全点决定是否允许浏览器资源恢复；它是本轮观察状态，不等于账号认证或永久解锁证明。

诊断只有固定技术码、渠道、状态、来源和计数，不放消息正文或 sender 显示名。健康监控必须消费结构化状态，不能以 warnings 数量或中文文案匹配判故障。原消息与显示标签仅供需要它们的受鉴权上下文／诊断接口读取，不写入普通日志。

## 尚未启用的真实收发

仍需取得服务器接收端与另一端对应的原生样本，证明参与者身份、入站 sender、稳定消息 UUID、完整正文、可靠时间来源及真实接收回执。单端硬刷新 UUID 稳定、`You`、`sent` 或 DOM 中出现正文，都不能独立证明平台已完成本次发送。

若后续只能取得分钟级时间，可另行审查版本化精度区间方案；本次没有实施或启用。该方案至少需要准确关联日期边界、同一渲染批次的浏览器本地日期与已验证时区，拒绝跨午夜旧 `Today`、时区变化及 DST 歧义，并让年龄、迟到提醒、遗忘恢复边界和回执分别消费精度。提交前的可靠最新尾部 UUID 基线、账号／会话／浏览器会话、契约版本及正文散列必须随提交意图持久保存，重启只用原基线回查。虚拟滚动、延迟同步旧消息、多个同文候选或其他客户端并发造成歧义时仍保持 unknown，不能用更宽时间窗口强行确认。

本次隔离 fixture 通过只证明读 DOM 和安全停机契约，不勾选真实 Chat 自动收发验收，不增加测试白名单，也不修改当前 `timestampReliable` 门禁。

## 隔离验证

`test/chat-dom.test.ts` 是原生字段纯解析回归。`test/chat-dom-acceptance.mjs` 在服务器 Camoufox 中加载 `test/fixtures/chat/` 的合成页面，验证 open ShadowRoot、ARIA 同 row 归属、requests／other 入口、原生字段不足诊断以及 legacy 安全行为。容器使用 `--network none`，没有挂载生产 profile，页面请求由本地 fixture 拦截，不访问 X 或真实模型。

本轮修订定向结果：字段解析 **8/8**、服务器 Camoufox DOM **11/11**，失败为零；独立 helper 的严格类型检查通过。最终扫描验证 legacy 主收件／请求各最多三会话，新 Chat 主收件／请求／Other 各最多两会话，总计不超过六个，避免主列表挤占所有请求名额。证据位于服务器 `/var/lib/role-workflow-repair-20261028/artifacts/chat-native-contract-v2/`，包括原始日志、JSON、源文件／编译产物散列和所用镜像 ID。`browser.ts` 的最终集成与整套回归仍由主代理统一完成；这些定向结果不代表生产启用。

首轮合成 fixture 使用了错误的 `<article>` 标签和 anchor 自身 testid，并把整个 content 当正文，虽曾通过 6／9 项隔离用例，但不能证明与真实结构一致。主代理对照已取得的 outerHTML 后指出这三处问题；本修订按真实外层属性契约重建脱敏镜像，并增加 focus-target、父容器／option 多重绑定、正文 overlay 与歧义反例。旧证据保留为历史，不作为本修订通过依据；新证据仍不是生产实时 DOM 或接收端收发验收。
