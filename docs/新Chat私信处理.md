# 新 Chat 一对一私信处理

## 行为与范围

`xchat-native-v2` 按顺序检查普通收件箱、Requests 和 Other。主收件箱为空仍继续检查请求。每个来源本轮最多选两个会话，总计最多六个并去重；来源内轮转，接受未知的原会话另有有界回查名额。缺入口、未检查、截止、结构不符与正常空态分别记录。

正常一对一纯文本请求先经过现有广告关键词过滤、骚扰冷却、遗忘、有效年龄、自动模式、回复时段和私信通道限制。全部通过后保存接受意图，再核对唯一 Accept 控件并接受。接受后必须出现同一会话的有效编辑器和发送控件，重新读取原生事件，再进入原有分级、记忆、模型、outbox 和发送流程。广告和受保护请求留在平台原位置，不执行 Delete 或 Block。

暂停、人工接管和草稿模式不自动接受；关闭回复时段、额度或同通道 unknown 等限制生效时保留等待。动态页显示请求等待、按规则保留和结果待回查；请求计入待处理数，但不会伪装成已采集的普通消息。日志使用 `private-request-state`，采集健康分别记录来源状态。

## 可靠消息契约

外层仍沿用同一 UUID 的 row、article 焦点目标、ARIA sender/time/content 和唯一正文子树。原生 React fiber 中 `messageItem` 与 `chatItem` 必须绑定同一对象且 `isOneToOne=true`。只读取公开 getter：`id`、`created.epochSeconds/nanosecondsOfSecond`、`senderInfo.userId.userId`、`textContent/fullText`、`sequenceNumber.num`、`messageInfo.showTimestamp` 以及类型与完整性标志。BigInt 转为十进制字符串。

当前账号数字 ID 取自同一浏览器会话的 `twid`，同时核对公开登录 handle；不返回、保存或记录 cookie 原值。数字双方会话必须包含当前账号和唯一另一参与者。入站只接受 `ReceivedMessageTextOnly` 加对方 ID；出站只接受 `SentMessageTextOnly` 加本人 ID 和原生 You 标签。非 You 不反推为入站。

机器时间、完整正文、正平台序号、同会话底部及版本绑定均有效时，才产生可靠事件。链接显示被缩略时只在已绑定正文内重建原 href；深度或数量超限不返回局部正文。只提供 Today／分钟显示标签、群聊、附件消息、不可解密、截断、字段冲突及未知结构继续保留观察诊断，不能填入采集时间或猜测归属。旧 `xchat-observation-v1` 仍不产生自动事件，legacy 路径保留。

## 持久状态及恢复

应用使用 schema 14 的版本化 runtime 命名空间 `private-request-v1:<账号>:<会话>`，仅保存原生 ID、状态、来源、时间和原因，不保存消息正文。接受副作用使用 browser profile 下的 `private-accept-v1.json`，在点击之前原子写入并 fsync 文件及目录；unknown 不按数量清理。重启只核对平台现状，不能重复点击 Accept；接受后出现的后续消息不能覆盖原接受指纹。

发送沿用原 transport journal／outbox。原生分支额外冻结账号、会话、目标消息 UUID、发送前 UUID 集合、浏览器会话及本次观察到的本地 `PendingMessageTextOnly` UUID。该 ID 持久绑定后，只有相同 UUID 转为本人 `SentMessageTextOnly`、正文和机器时间相符且具有正平台序号，才确认回执。其他客户端同步的同文 Sent、多个 Pending、缺原意图、超时及证据不足均保留 unknown，只回查。公共通道旧 unknown 不被清理或重发。

## 证据与边界

2026-10-29 生产只读取证确认了 Requests 菜单、`/i/chat/requests`、Other 按钮、`/i/chat/requests/other` 和请求详情控件，以及五条实际入站消息的公开 getter。SDK 来源为 `https://abs.twimg.com/x-web/xchat/embed/assets/dm-core-DNH_F-Zu.js`，SHA-256 为 `20b6ce1c304128b26c3c0c57abca8bd5534ada8328c97a855ec4179ff1afe18f`。原始消息保存在服务器受限发布目录，不入仓库。

服务器定向单元 16 项、全套单元 709 项和独立 Camoufox 原生 DOM 六项通过。DOM 用合成账号和消息，网络全部拦截，不连接生产 profile、X 或模型。分别验证主收件箱为空继续 Other、真实机器字段绑定、接受后重读、未知重启不重复接受、本地 Pending→Sent 及同文并发隔离。首轮夹具时间变化和产物目录权限失败保留记录。

真实请求接受、生产模型回复、实际发送和双方回执须分别记录；隔离测试与代码部署不代表这些真实业务验收已通过。当前生产暂停时不自动恢复；默认 23:30–08:00 关闭回复，保持现有时段策略。实际多媒体、群聊及未见过的原生结构不在本契约自动回复范围内。

## 回退

保留 0.1.26 app／browser 成对镜像。先等待业务结束并暂停，停止两容器，把 `ROLE_VERSION`、`APP_VERSION`、`BROWSER_VERSION` 恢复为 0.1.26 后成对启动。无 schema 变更；不还原数据库、profile、配置、人设或模型，不删除新接受日志及 transport journal。已接受的平台请求不能由版本回退撤销，unknown 必须保留供后续核对。恢复控制前重新确认管理员最后操作，不能恢复历史运行态。
