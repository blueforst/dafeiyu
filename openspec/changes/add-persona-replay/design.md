# 人设回放技术设计

## Context

动机见 [proposal.md](proposal.md)，行为契约见 [persona-replay 规格](specs/persona-replay/spec.md)。

- `PersonaService.preview()` 已支持用未保存人格做多轮试聊：调用 `assemble()`（含语义判定）与 `generator.complete()`，以 `persona-preview` 用途计量，结果不写出站或记忆。回放可以复用这条隔离生成路径。
- 生产 `Workflow.tick()` 中，`transport.context()` 返回的对话上下文和 `memory.context()` 的召回结果只在内存中使用，没有持久化；消息表保存入站 `body` 与 `draft`（回复或跳过）。因此历史消息的“当时上下文”目前无法还原。
- 遗忘与删除由 `Store.forget()`、`MemoryService` 的删除账本和 `forget-ledger.json` 等独立账本保证，恢复旧库时会重放；任何新增的原文派生数据都必须纳入这些路径。
- `llm_calls` 按 `purpose` 计量，计费页按用途汇总。

## Goals / Non-Goals

**目标：** 回放与试聊共用组装和生成代码，保证“回放看到的就是生产会做的”；新增数据全部受遗忘、删除和保留期约束；指标计算与提示词提醒共用检测函数。

**非目标：** 不做模型评审打分；不支持跨账号回放；不自动根据结果修改人设；不回放早晚安帖（只回放回复与私信）；不重新读取 X 页面获取上下文。

## Decisions

### 1. 生成输入快照

迁移新增 `generation_snapshots(message_id PRIMARY KEY, account_id, user_id, channel, created_at, body_json)`。`Workflow` 在 `assemble()` 之后、生成之前写入 `{conversation, memory, hintMeta, dailySlot, personaRevision}`，序列化上限 16 KB（超出时截断对话最早部分并标记）。清理路径：

- `Store.prune(retentionDays)` 按 `created_at` 同步删除。
- `Store.forget()` 与记忆删除账本重放时按 `account_id + user_id + channel` 删除；遗忘账本恢复旧库时同样执行。
- 记忆条目被管理员删除或修订时，快照中的 `memory` 部分不再用于回放：回放时用当前允许范围的召回替换快照记忆，只保留快照中的对话上下文。这样既能还原对话，又不会让已删除的记忆通过快照复活。

*备选*：回放时重新打开 X 页面读取上下文。需要浏览器互斥、会与生产抢占并产生平台读取，且帖子可能已删除，被否决。

*备选*：完全不存快照，只用原文。实现最简单但对话类消息失真严重；保留为无快照时的降级路径。

### 2. 样本选择

查询 `messages` 中当前账号、状态为 confirmed／draft／skipped 的入站消息，按日期、渠道、`tier`（若 `add-reply-triage` 已实施）筛选；排除 `forgotten()` 用户、来源账本中已删除的消息。默认按时间均匀抽样，也可按最新排序。私信必须显式勾选。

### 3. 执行与隔离

新增 `ReplayRunner`：内存队列加 `replay_runs(id, created_at, status, settings_json, persona_json, baseline_mode, estimate_json, summary_json)` 与 `replay_items(run_id, message_id, baseline_json, candidate_json, label, issues_json, metrics_json, status)`。并发 1（可设为 2），每条依次执行：

1. 读取快照或降级上下文；日程统一使用运行开始时的模拟日程文本，时间固定为样本消息的平台时间加一分钟，使迟到提醒不因回放时间而失真。
2. 候选：`assemble()` + `complete()`，人格为草稿，提醒设置为草稿设置；会话标识为 `replay-<runId>-<itemId>`，不复用生产会话，避免影响 OpenCode 会话路由。
3. 基线：模式为“当时实际回复”时直接读取 `draft`；模式为“当前已保存人设”时用已保存人格重复第 2 步。
4. `parseDraft()` 与公开长度校验结果写入条目；失败记录错误，不重试。

元数据中 `purpose: 'persona-replay'`、`source: 'panel-replay'`、`interactionId: runId`。中止通过 `AbortController` 传入 `complete()`。运行不读取或写入 `messages`、`outbox`、记忆表，不调用 transport。

### 4. 费用预估

请求数 = 样本数 ×（候选 1 + 有启用触发规则时 1）+ 基线重新生成时同等数量。单次费用用当前模型最近 50 次 `reply` 与 `semantic-trigger` 调用的平均已定价成本估算；没有历史或未定价时只显示请求数与“未定价／无法估算”。确认弹窗展示上述数字；运行完成后显示实际费用（来自 `llm_calls` 按 `interactionId` 汇总）。

### 5. 指标计算

共享模块 `src/reply-style.ts` 提供 `opening(text)`、`expressions(text)`、`hasSteps(text)`（编号列表、“第一步”“首先…然后…最后”等）；`improve-reply-prompt-context` 的提醒使用同一模块。指标：跳过率、平均字符数、开头重复率（重复组内的全部回复数 / 回复总数；20 条中同一开头出现 6 条时为 30%，与增量规格场景一致）与前五开头、颜文字／emoji／“～”每十条频率、列步骤比例、禁用链接与提及数、公开长度违规数。生产统计按北京日期分组，结果缓存到当天结束前五分钟内的请求。

### 6. 界面

人设页新增“回放对比”区：样本筛选、预估与确认、进度、并排列表（原消息、基线、候选、标记按钮、问题类别多选）、汇总卡片；“回复质量”区：日期范围、渠道切换、指标趋势小图与表格。外部文本按纯文本渲染。私信条目在列表中默认折叠，展开时走受鉴权接口读取。

## Risks / Trade-offs

- [快照增加存储与隐私面] → 有界大小、保留期与原文一致、纳入遗忘与删除；快照记忆在回放时被当前召回替换，不会复活已删除内容。
- [回放费用超预期] → 每次最多 50 条、运行前确认、可中止、按用途可查。
- [回放与生产并发占用服务商速率] → 默认并发 1；生产调用失败时可先中止回放。
- [基线“当时实际回复”与候选的上下文不同] → 页面注明基线模式；需要严格对照时选择“当前已保存人设重新生成”。
- [确定性指标无法衡量“好不好”] → 指标只用于发现模式问题，结论以人工标注为准。

## Migration Plan

1. 迁移新增三张表，可重复执行；上线前处理的消息没有快照，回放时标注上下文不完整。
2. 遗忘、删除、恢复旧库路径的回归必须覆盖新表后才能发布。
3. 回退时旧版本忽略新表；`rollback-schema.py` 检查到快照或回放数据时提示可安全删除这些派生表，不影响业务数据。

## Verification

- 单元测试：样本筛选与排除规则；快照截断；指标计算样本；费用预估在未定价和无历史时的显示。
- 集成测试：回放期间 `messages`、`outbox`、记忆表行数与内容不变；遗忘后快照与回放条目被移除；恢复旧库后重放遗忘仍删除快照；中止后不再产生调用；采用候选的修订冲突。
- 所有构建与测试在服务器隔离环境执行；真实模型回放需在取得授权后进行并记录实际费用。
