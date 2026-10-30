# 必要时在完整轮次结束后自动恢复浏览器

状态：实现及服务器隔离验收已完成（794项单元、health DOM16项、六场景独立容器broker），正式0.1.28.8已成对healthy并恢复running／auto，真实自然触发后verify-chat失败并安全暂停，冷启动完整验证等待正在修复，5组仍未完成。当前本机与服务器均缺少OpenSpec CLI，本提案仅完成手工产物编写，不宣称执行过CLI校验。

## Why

生产已恢复正常轮次，但浏览器资源提示随内存波动持续为attention。现有恢复入口位于prepare-round，已解锁Chat及仍保留的历史unknown又会阻止关闭上下文，导致有必要的资源恢复无法自然到达安全时机。health缓存中的businessBlocked也不能证明某次临界压力下的真实准入结果。

用户已明确要求程序在必要时自动等待完整轮次结束后重启浏览器，而不是提供一次手动重启。本轮授权包含针对有效精确审核旧unknown和已解锁Chat的有限维护例外；未审核的新unknown、提交中出站、未收束私信接受、需要人工处理及接管仍受保护。

## What Changes

- prepare-round继续采样和决定本轮业务准入，实际context close／launch移至完整轮次后的串行维护RPC；采集、入队、生成、发送、整理及scheduler均await结束，控制仍running且未abort，busy释放前才可调用。
- 仅有soft保护（有效精确reviewed旧unknown、已解锁Chat）且明确启用allowSessionRecovery策略时，不在prepare提前以临界压力fault／blocked，允许完整执行该轮后再评估维护。新hard unknown临界时继续只回查并early return，不执行轮末维护；未完成链路不通过finally补做重启。
- 沿用BrowserResourceGuard内部context close／launch、同一profile、设备及journal，以及持续压力至少30秒／至少两次有效采样、最小五分钟间隔、每小时最多两次等现有频率约束。
- 在轮末重新检查控制、保护和审核指纹；旧unknown的原状态、冻结内容、回查及禁止重发保持，维护例外不转成全局资源或发送豁免。
- 重启前后核对同一账号及本次关闭的原已接受Chat的实际可读、可编辑状态；不能用empty inbox证明解锁。失败安全暂停，保留失败阶段，不自动重复restart。
- 分开记录待轮末、被保护延后、正在恢复、已验证成功和失败，保留内存、次数及阶段证据；不因cached businessBlocked=false显示或宣称所有临界业务均可继续。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `runtime-health`：浏览器资源恢复改为完整轮次后自动执行，并增加有限soft准入、精确审核维护例外、原已接受Chat恢复验证及失败收束要求。

## Impact

涉及工作流轮末顺序、传输与浏览器串行RPC、BrowserResourceGuard、私信保护／接受状态、精确unknown审核及健康阶段记录。沿用schema14的profile、设备、出站与审核账本，预期无需数据库迁移，不增加模型调用或平台测试消息。

服务器隔离验证、真实自动恢复验收和正式成对发布分别记录，任务初始均未完成。回退恢复原成对代码与原门禁，不还原旧业务库、不清空journal；已经关闭的内存会话不能靠回退伪称恢复，失败时保持暂停并保留实际Chat状态。
