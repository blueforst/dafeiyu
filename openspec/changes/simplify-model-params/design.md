# 模型参数精简设计

## 背景

现状（源码 `746ba7e`）：

- `PanelModel` 和模型库 `LibraryParams` 都有 `maxTokens`（默认 4096，范围 64–8192）和 `timeoutMs`（默认 60000，范围 1000–180000）。
- 配置文件来源的模型在 `config.ts` 中按同样范围校验。
- `runCompletion` 中：
  - `maxTokens = requestMaxTokens(opts.maxTokens ?? m.maxTokens, model, level)`：开启推理且协议不自带思考预算时，加上 `THINKING_BUDGET`，再与 `model.maxTokens` 取小；
  - `AbortSignal.timeout(m.timeoutMs)` 与调用方的 `signal` 合并。
- 内部固定上限：
  - 语义路由 512（`convert-trigger-cards-to-skills` 删除这条路由）；
  - 虚构日程 `min(配置值, 3072)`；
  - 连接测试关闭推理时 16、开启时 2048。

管理员确认：

- 删除页面上的“回复长度上限”和“超时”；
- 输出上限只受 X 账号的发帖限制约束。

## 1. 输出上限

`runCompletion` 改为：

```ts
const cap = opts.maxTokens ?? model.maxTokens;   // 未指定时取模型自身最大值
const budgeted = requestMaxTokens(cap, model, level); // 原有逻辑：有上限时再加思考预算并与 model.maxTokens 取小
const maxTokens = fitContext(budgeted, model.contextWindow, inputEstimate);
```

- `model.maxTokens` 来自 Pi 目录；目录识别不到的自定义模型由 `resolveRuntimeModel` 给出 8192。现有逻辑不变。
- 内部调用继续显式传入各自的上限：
  - 连接测试见 `convert-trigger-cards-to-skills` 第 7 节；
  - 虚构日程把 `Math.min(original.model.maxTokens,3072)` 改为调用时传 `maxTokens: 3072`。

`fitContext` 的规则（我的决定）：

- 输入量用 `inputEstimate` 估算：system 与全部消息文本的 UTF-8 字节数除以 2，向上取整。这样估得偏大，宁可少给输出空间，也不让请求超过上下文。
- `contextWindow - inputEstimate - 1024` 小于 `budgeted` 时，取前者；结果至少 256。
- 输入本身已经超过上下文长度时不做处理，交给接口报错，与现在一致。

## 2. 固定保护时限

- `model.ts` 导出常量 `MODEL_REQUEST_TIMEOUT_MS = 180000`，`runCompletion` 用它替代 `m.timeoutMs`。
- 180 秒是原来允许的最大值，原来能完成的请求不会因此新增失败（我的决定）。
- 超时仍表现为 `TimeoutError`，经现有的失败分类（`unattended-health.ts`）归为 `timeout`。
- 与调用方 `signal` 的合并不变，轮次硬超时仍能立即中止请求。

## 3. 参数结构与兼容

- **类型**
  - `PanelModel`、`LibraryParams` 删除 `maxTokens`、`timeoutMs`。
  - `Config['model']` 删除这两个字段，`toConfigModel` 不再输出它们。
  - `DEFAULT_PARAMS` 改为 `{reasoningLevel:'off'}`。
- **读取**
  - 面板设置中旧模型参数的这两个字段在解析时丢弃，不校验。
  - `sameModel` 比较不再包含它们，因此升级后不会把同一模型误判为不同配置。
- **写入**：模型参数保存、模型库更新时，写回的对象不含这两个字段。
- **接口**
  - `PUT` 模型参数和旧模型接口收到这两个字段时忽略。
  - `GET` 不再返回这两个字段。
  - 前端不再发送它们。
- **配置文件**：`config.ts` 不再要求、也不校验 `model.maxTokens`、`model.timeoutMs`。存在时忽略，`config.example.json` 删除这两项。
- **回放**：新回放记录的模型快照（`persona-replay.ts`）不再包含这两个字段；读取旧记录时照常显示。
- **数据库**：不需要迁移。

## 4. 前端

- `model.js` 的 `editModel` 删除两个输入框和对应快照字段。已识别模型的窗口只剩推理强度；未识别模型另有上下文长度和是否支持推理。
- “手动添加 ID”的默认参数只保留 `reasoningLevel:'off'`。
- `model-form.js`（旧单模型表单）同步删除这两项，提交时不发送。

## 5. 项目约定与文档

- `openspec/config.yaml` 的 design 规则：“保留 OpenCode 会话路由、默认 4096 token 和 CommandCode 未定价等现有行为”改为“保留 OpenCode 会话路由和 CommandCode 未定价等现有行为；回复请求输出上限取模型自身最大值”。
- `docs/模型库.md`：删除“4096 token 默认回复上限”，补充输出上限与固定时限的说明。
- `docs/前端接口.md`：模型参数结构。

## 6. 失败与回退

- 回退到旧版本时，旧代码要求这两个字段存在，而升级后再次保存过的模型参数已经没有它们。旧代码读取不到时会用默认值或报错，取决于具体入口。
- 回退前先恢复发布前备份的面板设置，或手动补上这两个字段（默认 4096 和 60000）。回退步骤写入发布记录。
- `config.example.json` 删除字段不影响已有的 `config.json`。

## 7. 验证

- **单元测试**（服务器）
  - 未指定上限时取 `model.maxTokens`，显式上限仍生效。
  - 开启推理时的预算计算与原逻辑一致。
  - `fitContext` 覆盖三种情况：不触发、收小、最低 256。
  - 请求超时为 180 秒（用假计时验证），调用方中止立即生效。
  - 配置文件缺少或带有旧字段都能加载。
  - 旧面板设置读取后 `sameModel` 不误判。
  - 保存后旧字段被移除；接口带旧字段时忽略。
- **界面验收**：编辑窗口没有这两项；未识别模型仍要求上下文长度与推理支持。
- **回归**：模型库、计量、回放、日程、连接测试的原有测试通过；依赖 4096 默认值的断言按新规格更新并在记录中列出。
- 本提案不需要真实模型调用。发布后用生产只读读回确认模型参数中已无这两个字段，并抽一条正式回复的调用记录，确认没有因长度截断失败。
