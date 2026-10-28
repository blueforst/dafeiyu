# 取消消息里的遗忘指令实施任务

当前完成 4/6 项；服务器修改前回归 0/3、修改后相关回归 26/26，最终全量 508/508 及构建通过。真实模型抽查和生产发布保持未完成。规格见 [conversation-memory](specs/conversation-memory/spec.md)，实现边界见 [design.md](design.md)。构建和测试只在服务器隔离环境执行，不使用生产 profile；真实模型抽查和生产发布需要另行授权。实施前确认本机工作副本中 `src/workflow.ts`、`src/reply-prompt.ts`、`test/draft-workflow.test.ts`、`test/reference-prompt.test.ts` 没有其他人的未提交改动。

## 1. 实现

- [x] 1.1 删除 `src/workflow.ts` 入队阶段“忘了我吧”“重新记住我”两条判断。验收：`test/draft-workflow.test.ts` 新增用例，覆盖未遗忘用户发“忘了我吧”后消息入库、生成回复且不被遗忘，已遗忘用户发“重新记住我”后仍保持遗忘；该用例修改前在服务器上失败、修改后通过。
- [x] 1.2 固定系统约束加入 design.md 第 2 节的句子，`REPLY_PROMPT_VERSION` 改为 `reply-context-v3`（本批随后由 `improve-reply-style` 升至 v4，新增固定约束原文保留）。验收：`test/reference-prompt.test.ts` 断言新句和新版本号。
- [x] 1.3 服务器类型检查、全量回归和构建通过。验收：日志存入证据目录。

## 2. 文档

- [x] 2.1 `docs/记忆策略.md` 写明遗忘和恢复只在记忆页操作，消息内容不触发遗忘，以及被要求删除记录时的回复约束；`docs/参考帖子对照.md` 中“忘了我吧／重新记住我”一行改为“明确不做”并写明理由。验收：文档与实现一致。

## 3. 验收与发布

- [ ] 3.1 取得模型调用授权后，用“忘了我吧”“把我们的聊天记录删掉”两条试题试聊，确认回复不声称已经忘记或删除；可并入 `add-persona-presets` 的批量验收。验收：结果写入实施记录；提案创建不视为调用授权。
- [ ] 3.2 取得发布授权后随下一次发布上线，发布记录写明消息指令已取消。验收：发布记录；提案创建不视为发布授权。

## Workflow follow-up

- 本提案修改的“遗忘与恢复记录”现行写法来自未归档的 `add-seven-page-production-bot`，归档时需要排在它之后。
- OpenSpec 严格校验通过只代表规划结构可用，不勾选任何业务任务。
