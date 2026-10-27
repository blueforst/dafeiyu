# 面板重做与模型配置 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 把角色工作流的运行面板重做为"概览 / 模型 / 浏览器"三页，模型可在面板上通过 pi 内置服务商或自定义 Base URL 配置、测试和保存，预期账号可在面板上设置。

**Architecture：**
- 后端在现有 Fastify 应用里新增三个模块，只对 `config.ts`、`app.ts`、`types.ts` 做最小接入：
  - `settings.ts`：面板设置和 Key 存放在可写的 `/data/panel/`；
  - `model-catalog.ts`：pi 模型目录、拉取模型列表、构造运行时模型；
  - `model-routes.ts`：新增的 HTTP 接口。
- `model.ts` 改为用 pi 的 `builtinModels()` 调用内置服务商；自定义服务商仍走 `createProvider`。
- 前端用原生 ES 模块，hash 路由，没有构建步骤。
- 开发在独立副本和独立的 staging 环境里进行，最后按设计文档 6.5a 的流程合入生产。

**Tech Stack：** TypeScript（NodeNext、strict）、Fastify 5、node:test + tsx、`@earendil-works/pi-ai@1.4.0`、node:sqlite、原生 HTML/CSS/JS、Playwright（浏览器镜像里的 playwright-core + chromium）、Docker Compose。

**Spec：** `docs/superpowers/specs/2026-10-27-panel-redesign-design.md`（下文简称"设计"）。执行时两份文档都要读。

## 工作方式（所有任务通用）

- **本地工作副本**：`/Users/forst/code/server/role-workflow-panel`（git 仓库）。所有编辑都在这里做。
  - **不要**编辑 `/Users/forst/code/server/role-workflow`，那是 GPT 的同步目录。
- **服务器开发副本**：`dsh:/srv/role-workflow-panel`。
  - 用 `dev/sync.sh` 把本地副本推送过去。用 rsync，排除 `node_modules`、`.git`、`dist`，服务器上的 `node_modules` 不会被删掉。
- **单元测试**：`dev/t.sh [测试文件…]`。
  - 它会在服务器上起一个 `node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` 容器，挂载开发副本，先跑 `npx tsc --noEmit`，再跑 `node --import tsx --test <文件，默认 test/*.test.ts>`。
  - 通过的标准：tsc 没有输出，并且 node:test 汇总里 `fail 0`。
- **E2E 测试**：`dev/e2e.sh`。
  - 用当前生产使用的浏览器镜像（`role-workflow-browser:$(cut -d= -f2 /srv/role-workflow/.env)`），加上 `--network host`，挂载 `/srv/role-workflow-panel/test:/app/test:ro` 和 `/var/lib/role-workflow-panel/artifacts:/artifacts`。
  - 运行参数照抄现有的浏览器测试命令：`--cap-drop ALL --security-opt no-new-privileges:true --security-opt seccomp=/srv/role-workflow/seccomp_profile.json --shm-size 256m --memory 768m`。
  - 执行 `node test/panel-e2e.mjs`。通过的标准：输出 JSON 里 `errors` 为空。
- **提交**：每个任务结束时在本地副本里 `git commit`。
- **Task 11 之前**，对生产的 `/srv/role-workflow` 和 `/var/lib/role-workflow` 只读不写。

## Global Constraints

- 只使用 `@earendil-works/pi-ai@1.4.0`，**不新增任何 npm 依赖**。前端不用框架、不用构建工具、不加载外部资源（CDN、字体）。
- 回复长度上限 `maxTokens`：默认 1024，范围 64–8192，且不超过模型自身的 `maxTokens`。超时：默认 60000 ms，范围 1000–180000。
- 预期账号先去掉 `@`、转小写，然后必须匹配 `^[a-z0-9_]{1,15}$`。空字符串表示清除面板设置的值。
- **Key 规则**：
  - 绝不出现在任何 HTTP 响应、日志、错误信息里；页面上最多显示 `••••` 加末 4 位。
  - Key 文件和设置文件的权限都是 0600，写入方式是先写 `.tmp` 再 rename。
- **Key 槽位**：`<provider>@<baseUrl 的 hostname>`。
  - 旧的 `/run/role-secrets/model_api_key` 只在 `config.model.source !== 'panel'` 时使用。
- **Base URL 校验**（只在面板保存、测试、拉取列表时做）：
  - 只允许 http 或 https，URL 里不能带用户名和密码。
  - hostname 不能是 `browser`、`app`、`localhost`、`0.0.0.0`、`::1`，也不能落在 127.0.0.0/8 或 169.254.0.0/16。
- **拉取模型列表**：超时 15 秒，最多返回 1000 个。
- **测试连接**：
  - 模型支持 `off` 时，关闭推理，`maxTokens` 设为 16。
  - 不支持 `off` 时，用 `getSupportedThinkingLevels` 的第一档，`maxTokens` 设为 2048。
  - 只有 `stopReason` 为 `error`、`aborted` 或抛出异常才算失败，`length` 算通过。
- **推理额度**（Anthropic 协议由 pi 自己加，不加）：minimal 1024、low 2048、medium 4096、high 8192、xhigh 16384、max 16384。
- 所有非 GET 请求都要带 `X-Workflow-Control: 1`。控制操作的客户端超时不少于 110 秒。
- **固定文案**（必须完全一致）：
  - 按钮：恢复处理 / 暂停 / 释放接管 / 接管并连接 / 连接桌面 / 释放并断开 / 测试连接 / 保存 / 用 Key 拉取 / 用当前登录
  - 状态：已暂停 / 处理中 / 等待当前操作结束 / 人工接管中
  - 模式说明：草稿模式 · 只生成草稿，不发送 / 自动回复
  - 待回查提示：`N 条发送结果待回查`
  - 其他提示：只显示运行事件，不含消息正文 / 会产生少量费用 / 地址的主机变了，请重新填写 Key / 未通过测试，仍要保存吗 / 下一轮处理生效 / 处理保持暂停，可在右上角恢复 / 浏览器未连接 / 先暂停
- **DOM 渲染**：日志、模型名等所有外部文本一律用 `textContent`，禁止 `innerHTML`。确认框只做成页内的，不调用 `window.confirm`。
- 配色跟随 `prefers-color-scheme`。在 375px 宽度下 `document.documentElement.scrollWidth <= 375`。

## Review Focus

1. **生产验收时处理正在运行**：按理说验收脚本应该拒绝执行，绝不能为了测试去接管、暂停正在跑的处理。由 Task 10 负责。
2. **面板设置文件损坏**（半截 JSON）：按理说 `/api/status` 应显示 `configError`，面板照常能打开，重新保存模型能把文件修好，进程不崩。由 Task 2 和 Task 5 负责。
3. **Base URL 写法不同**（结尾带 `/`、带 `/v1`、带端口）：按理说 Key 槽位只按 hostname 计算；拉列表时路径里不出现 `//`，也不出现重复的 `/v1`。由 Task 2 和 Task 4 负责。
4. **刚填了新 Key 就切换服务商或改了主机**：按理说输入框里的 Key 要被清空，绝不能发到新的主机去。由 Task 8 负责。
5. **接口一次返回 1500 个模型**：按理说只保留 1000 个，下拉框可以搜索，页面不卡死。由 Task 4 和 Task 8 负责。

---

### Task 1: 工作区、基线快照与协作文件

**Files:**
- Create（本地）：`/Users/forst/code/server/role-workflow-panel/`，内容是服务器 `/srv/role-workflow` 的拷贝，排除 `node_modules`、`dist`、`.env`。
- Create：`.gitignore`（忽略 `node_modules/`、`dist/`、`.env`）、`dev/sync.sh`、`dev/t.sh`
- Create（服务器）：`/srv/role-workflow-panel`，用 `cp -a /srv/role-workflow` 复制，包含 `node_modules`。
- Create（服务器和本地 GPT 副本各一份）：`docs/协作-面板重做.md`

**Interfaces:**
- Produces：git 标签 `baseline`，记录开发开始时生产源码的状态，Task 11 合并时要用；`dev/sync.sh`、`dev/t.sh`。

- [ ] **Step 1：** 在服务器上执行 `cp -a /srv/role-workflow /srv/role-workflow-panel`，再用 rsync 把同一份源码拉到本地工作副本，排除 `node_modules`、`dist`、`.env`，并且不拉 `交付资料`。
- [ ] **Step 2：** 在本地执行 `git init`，写好 `.gitignore`，然后 `git add -A && git commit -m "baseline: production source snapshot" && git tag baseline`。
- [ ] **Step 3：** 写 `dev/sync.sh`（`rsync -az --delete --exclude node_modules --exclude .git --exclude dist ./ dsh:/srv/role-workflow-panel/`）和 `dev/t.sh`（命令见"工作方式"一节）。
- [ ] **Step 4：** 执行 `dev/sync.sh && dev/t.sh`。预期 tsc 没有输出，并且 `fail 0`。这一步的作用是确认现有 13 项测试在开发副本里都能通过。
- [ ] **Step 5：** 写协作文件 `docs/协作-面板重做.md`，内容包括：
  - 分工，抄设计 6.5 节；
  - 冻结的文件：`src/config.ts`、`src/app.ts`、`src/types.ts`、`src/model.ts`；
  - 状态：`开发中（未合入）`；
  - 给 GPT 留言的区域。

  在服务器上放到 `/srv/role-workflow/docs/` 下（目录不存在就新建），并复制一份到本地 GPT 副本的 `docs/` 下。
- [ ] **Step 6：** 提交：`git add -A && git commit -m "chore: dev scripts and coordination note"`

### Task 2: 面板设置存储与配置合并

**Files:**
- Create：`src/settings.ts`
- Modify：
  - `src/types.ts`：`Config.model` 增加可选字段 `source?: 'panel'|'config'` 和 `custom?: {contextWindow:number;reasoning:boolean}`；
  - `src/config.ts`：在 `loadConfig` 的校验之前调用 `mergePanel`；只在 `provider==='custom'` 或 `source!=='panel'` 时检查 api 是不是那三种；`redact` 增加对 `allModelKeys()` 的打码。
- Test：`test/settings.test.ts`

**Interfaces:**
- Produces（`src/settings.ts`）：
  ```ts
  export type ReasoningLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
  export type PanelModel = { provider:string; baseUrl:string; api?:'openai-completions'|'openai-responses'|'anthropic-messages'; id:string; reasoningLevel:ReasoningLevel; maxTokens:number; timeoutMs:number; custom?:{contextWindow:number;reasoning:boolean} };
  export type PanelSettings = { expectedHandle?:string; model?:PanelModel };
  export function panelDir():string;                       // (DATA_DIR||'/data')+'/panel'
  export function readPanelSettings(opts?:{tolerant?:boolean}):PanelSettings; // 文件不存在时返回 {}；JSON 损坏时，严格模式抛出 Error('面板设置文件损坏')，宽松模式返回 {}
  export function writePanelSettings(next:PanelSettings):void;
  export function keySlot(provider:string, baseUrl:string):string;
  export function readModelKey(slot:string):string;        // 没有时返回 ''
  export function writeModelKey(slot:string, key:string):void;
  export function allModelKeys():string[];
  export function keyHint(key:string):string;              // '••••'+末4位；key 为空时返回 ''
  export function validateHandle(raw:string):string;       // 不合法时抛出 Error('账号名称无效')
  export function checkBaseUrl(raw:string):URL;            // 不合法时抛出 Error('模型地址无效：…')
  export function toConfigModel(p:PanelModel):Config['model'];
  export function mergePanel(c:Config, p:PanelSettings):Config;
  ```
  - `toConfigModel` 返回 `{provider, api: api ?? '', baseUrl, id, reasoning: reasoningLevel!=='off', reasoningLevel, vision:false, maxTokens, timeoutMs, source:'panel', custom}`。
  - `mergePanel`：`expectedHandle` 不为 undefined 时覆盖。有 `model` 时，把 `c.model` 替换为 `toConfigModel(model)`；否则设置 `c.model.source='config'`。

- [ ] **Step 1：写失败的测试** `test/settings.test.ts`。每个测试都把 `DATA_DIR` 和 `SECRETS_DIR` 指向独立的临时目录。
  - `keySlot('custom','https://Relay.Example.com:8443/v1/')` === `'custom@relay.example.com'`；`keySlot('deepseek','https://api.deepseek.com')` === `'deepseek@api.deepseek.com'`
  - `writeModelKey('custom@a.example','sk-abcdef123456')` 之后：`readModelKey` 返回原值；`statSync(panelDir()+'/model-keys.json').mode & 0o777` === `0o600`；`keyHint('sk-abcdef123456')` === `'••••3456'`
  - `validateHandle('@Role_Demo')` === `'role_demo'`；`validateHandle('')` === `''`；`validateHandle('bad name!')` 抛出 `/账号名称无效/`
  - `checkBaseUrl` 对以下地址都抛出异常：`http://localhost:1`、`http://127.0.0.2/v1`、`http://169.254.169.254`、`http://browser:3001`、`http://app:8080`、`http://u:p@x.example`、`ftp://x.example`；对 `http://mock-model:8080/v1` 和 `http://192.168.1.10:11434/v1` 不抛出
  - `loadConfig(<把 config.example.json 写进临时目录后的路径>)`：
    - 面板设置为 `{expectedHandle:'role_demo', model:{provider:'google', baseUrl:'https://generativelanguage.googleapis.com/v1beta', id:'x', reasoningLevel:'high', maxTokens:1024, timeoutMs:60000}}` 时，结果中 `expectedHandle==='role_demo'`、`model.source==='panel'`、`model.reasoning===true`，并且不会因为 api 不是那三种而抛错
  - `settings.json` 内容为 `'{"model":'` 时：`loadConfig` 抛出 `/面板设置文件损坏/`；`readPanelSettings({tolerant:true})` 返回 `{}`
  - 写入一个面板 Key `abcd1234efgh5678` 之后：`redact('boom abcd1234efgh5678')` 不包含 `abcd1234efgh5678`
- [ ] **Step 2：** 执行 `dev/sync.sh && dev/t.sh test/settings.test.ts`。预期 FAIL，因为模块还不存在。
- [ ] **Step 3：** 按 Interfaces 实现 `src/settings.ts`，然后修改 `types.ts` 和 `config.ts`。`config.ts` 的改动不超过 6 行。目录 `panel/` 用 `mkdirSync(...,{recursive:true,mode:0o700})` 创建。
- [ ] **Step 4：** 执行 `dev/sync.sh && dev/t.sh`。预期全部测试 PASS，包括原有的 13 项。
- [ ] **Step 5：** 提交：`git commit -am "feat: panel settings store and config merge"`，记得 `git add` 新文件。

### Task 3: pi 目录与运行时模型

**Files:**
- Create：`src/model-catalog.ts`（这一步先实现目录和运行时部分，拉取列表留给 Task 4）
- Modify：`src/model.ts`，重写 `PiGenerator`，新增 `runCompletion` 和 `requestMaxTokens`；`parseDraft`、`publicLengthOK`、`Generator` 保持不变
- Test：`test/model-catalog.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `PanelModel`、`readModelKey`、`keySlot`。
- Produces（`src/model-catalog.ts`）：
  ```ts
  export type ProviderInfo = { id:string; name:string; group:'cn'|'intl'; baseUrl:string; apis:string[]; modelCount:number };
  export type ModelInfo = { id:string; name:string; api:string; baseUrl:string; contextWindow:number; maxTokens:number; reasoning:boolean; levels:string[]; vision:boolean; cost:{input:number;output:number} };
  export function listProviders():Promise<ProviderInfo[]>;
  export function listModels(providerId:string):Promise<ModelInfo[]>;              // 不存在时抛出 Error('未知服务商')
  export function findCatalogModel(id:string):Promise<ModelInfo|undefined>;        // 在所有服务商里精确匹配，取第一个
  export function primaryApi(providerId:string):Promise<string>;                   // 该服务商模型里出现最多的 api
  export function resolveRuntimeModel(m:Config['model']):Promise<{model:Model<Api>; models:Models}>;
  ```
  - `levels` 取 `getSupportedThinkingLevels(model)` 的结果（来自 `@earendil-works/pi-ai/models`）；不支持推理的模型为 `['off']`。
  - 国内组只包括这些：`deepseek, moonshotai-cn, zai-coding-cn, qwen-token-plan-cn, minimax-cn, xiaomi, xiaomi-token-plan-cn, ant-ling`。
  - 排除的服务商：`amazon-bedrock, openai-codex, github-copilot, typesafe`，以及 baseUrl 为空或包含 `{` 的，以及 auth 里没有 apiKey 的，以及没有聊天模型的。
  - `builtinModels()` 第一次调用时才 import，之后缓存在模块级变量里。
- Produces（`src/model.ts`）：
  ```ts
  export const THINKING_BUDGET:Record<string,number>;  // minimal 1024, low 2048, medium 4096, high 8192, xhigh 16384, max 16384
  export function requestMaxTokens(cap:number, model:Model<Api>, level:string):number;
  export type CompletionResult = { text:string; input:number; output:number; cache:number; stopReason:string; errorMessage?:string; latencyMs:number };
  export function runCompletion(m:Config['model'], key:string, system:string, user:string, opts?:{signal?:AbortSignal; maxTokens?:number; reasoning?:string}):Promise<CompletionResult>;
  ```
  - `resolveRuntimeModel` 的规则：
    - 内置服务商且目录里有这个模型：用目录里的模型；如果 baseUrl 和目录不同，就覆盖 baseUrl。
    - 内置服务商、但目录里没有这个 id：以该服务商第一个模型为模板，替换 `id`、`name` 和用户填的 `baseUrl`，并设 `contextWindow:128000, maxTokens:8192, reasoning:false`。
    - `custom`：用新的 `createModels()` 和 `createProvider`，api 按 `m.api` 选；如果 `findCatalogModel(m.id)` 能匹配到，只借用 `contextWindow/maxTokens/reasoning/input`；匹配不到就用 `m.custom`，没有 `m.custom` 时用 `{contextWindow:128000, reasoning:false}`；`compat:{supportsDeveloperRole:false}`。
  - `PiGenerator.complete(c,system,user,signal)` 的规则：
    - Key：`source==='panel'` 时用 `readModelKey(keySlot(provider,baseUrl))`，否则用 `readSecret('model_api_key')`。
    - Key 为空，或者 `id`、`baseUrl` 为空：抛出 `Error('模型未配置：请在面板的模型页填写服务商、模型和 API Key')`。
    - 调用 `runCompletion`，`stopReason` 为 `error/aborted/length/toolUse` 时抛错，这和现有行为一致。

- [ ] **Step 1：写失败的测试** `test/model-catalog.test.ts`：
  - `listProviders()`：
    - 结果的 id 里不包含 `amazon-bedrock, azure, cloudflare-ai-gateway, cloudflare-workers-ai, google-vertex, openai-codex, github-copilot, typesafe`；
    - `deepseek` 的 `group==='cn'`、`baseUrl==='https://api.deepseek.com'`、`apis` 等于 `['openai-completions']`；
    - `anthropic` 的 `group==='intl'`。
  - `listModels('deepseek')` 中 id 为 `deepseek-flash` 的项：`contextWindow===1000000`，`reasoning===true`，`vision===true`，`levels` 等于 `['off','low','high','max']`。
  - `listModels('nope')` 抛出 `/未知服务商/`。
  - `requestMaxTokens`（用 deepseek-flash 的运行时模型）：
    - `(1024, m, 'off')` → 1024；`(1024, m, 'high')` → 9216；
    - 把模型的 maxTokens 设为 4096 后，`(1024, m, 'high')` → 4096；
    - 对 anthropic 目录里任意一个推理模型，`(1024, m, 'high')` → 1024。
  - `resolveRuntimeModel`：
    - deepseek 的 baseUrl 改成 `http://127.0.0.1:9/x` → 结果的 `model.baseUrl==='http://127.0.0.1:9/x'`；
    - id 为 `brand-new` → `api==='openai-completions'`、`contextWindow===128000`；
    - custom、`api:'anthropic-messages'`、`id:'deepseek-flash'` → `api==='anthropic-messages'`、`contextWindow===1000000`、`compat` 不含 deepseek 的 `thinkingFormat`。
  - `runCompletion`：照现有 safety 测试的写法起一个本地 SSE 模拟接口，用 deepseek 服务商、把 baseUrl 改成模拟接口地址、Key 为 `k-unit-0001`。断言：请求头为 `authorization: Bearer k-unit-0001`，`body.model==='deepseek-flash'`，`max_tokens===1024`，返回的 `stopReason==='stop'`、`input===12`。
  - `PiGenerator`：
    - `source:'panel'`，并已写入 `deepseek@127.0.0.1` 的 Key → 请求用的是这个 Key，即使 `SECRETS_DIR` 里有另一个 Key `legacy-key-0000` 也不用它；
    - `source:'panel'` 但没有 Key → 抛出 `/模型未配置/`。
- [ ] **Step 2：** 执行 `dev/sync.sh && dev/t.sh test/model-catalog.test.ts`。预期 FAIL。
- [ ] **Step 3：** 实现 `src/model-catalog.ts` 的目录部分，并重写 `src/model.ts`。
- [ ] **Step 4：** 执行 `dev/sync.sh && dev/t.sh`。预期全部 PASS，现有的"Pi 适配器经过真实本地兼容接口…"测试也必须通过。
- [ ] **Step 5：** 提交：`git commit -m "feat: pi catalog and runtime model resolution"`

### Task 4: 拉取接口模型列表

**Files:**
- Modify：`src/model-catalog.ts`
- Test：`test/discover.test.ts`

**Interfaces:**
- Produces：
  ```ts
  export type DiscoverInput = { provider:string; baseUrl:string; api?:string; apiKey:string };
  export type DiscoveredModel = { id:string; known:boolean; info?:ModelInfo };
  export function discoverModels(input:DiscoverInput, fetchImpl?:typeof fetch):Promise<{models:DiscoveredModel[]; total:number}>;
  ```
  - api 的确定：`custom` 用 `input.api`，内置服务商用 `primaryApi(provider)`。
  - 拼接路径前，先去掉 baseUrl 末尾的 `/`。按 api 分别请求：
    - openai-* 和 mistral-conversations：`GET {base}/models`，带 `Authorization: Bearer`。
    - anthropic-messages：`GET {base}/v1/models`；base 已经以 `/v1` 结尾时用 `{base}/models`。请求头带 `x-api-key` 和 `anthropic-version: 2023-06-01`。
    - google-generative-ai：`GET {base}/models?key=`，返回的 id 要去掉前缀 `models/`。
  - 超时 15 秒。响应不是 2xx 时抛出 `Error('拉取失败：HTTP <status>')`，错误信息里不带响应正文。
  - `known` 和 `info` 的规则：内置服务商在该服务商的目录里查；`custom` 用 `findCatalogModel` 查。
  - 结果按 id 去重，最多保留 1000 个；`total` 是去重后的总数。

- [ ] **Step 1：写失败的测试** `test/discover.test.ts`，用本地 `createServer` 记录收到的请求：
  - custom、openai-completions、`baseUrl:'http://127.0.0.1:P/v1/'`：模拟接口返回 `{data:[{id:'deepseek-flash'},{id:'zzz-unknown'}]}`。断言请求路径为 `/v1/models`、请求头为 `Bearer k1`；结果第一项 `known:true` 且 `info.contextWindow===1000000`，第二项 `known:false`。
  - custom、anthropic-messages：`baseUrl` 为 `http://127.0.0.1:P` 时请求 `/v1/models`；为 `http://127.0.0.1:P/v1` 时也请求 `/v1/models`。请求头 `x-api-key==='k1'`。
  - google-generative-ai（直接传 `api` 走 custom 路径）：模拟接口返回 `{models:[{name:'models/gemini-x'}]}`，结果 id 为 `gemini-x`，请求 query 里 `key==='k1'`。
  - 模拟接口返回 1500 个不同的 id：结果 `models.length===1000`、`total===1500`。
  - 模拟接口返回 401 和正文 `secret-echo k1`：抛出 `/拉取失败：HTTP 401/`，错误信息不包含 `k1`。
- [ ] **Step 2：** 执行 `dev/sync.sh && dev/t.sh test/discover.test.ts`。预期 FAIL。
- [ ] **Step 3：** 实现 `discoverModels`。
- [ ] **Step 4：** 执行 `dev/sync.sh && dev/t.sh`。预期全部 PASS。
- [ ] **Step 5：** 提交：`git commit -am "feat: discover models from provider endpoint"`

### Task 5: 后端接口与接入

**Files:**
- Create：`src/model-routes.ts`
- Modify：`src/app.ts`
  - 在注册静态文件之前调用 `registerModelRoutes(app,{store, control:()=>workflow.control()})`；
  - `/api/status` 的 `config.model` 增加 `source` 和 `baseUrlHost`，`configured` 改为"按槽位或旧 Key 判断是否有 Key"；
  - `loadConfig` 抛错时，原有的 `configError` 逻辑保持不变。
- Test：`test/model-routes.test.ts`

**Interfaces:**
- Consumes：Task 2–4 的全部导出。
- Produces（HTTP，前端依赖这些）：
  - `GET /api/model` → `{source:'panel'|'config', settings:PanelModel|null, effective:{provider,id,api,baseUrl}, info:ModelInfo|null, keys:Record<string,string>, lastTest:LastTest|null}`。其中 `keys` 是"槽位 → keyHint"，包含所有已保存的槽位。
  - `GET /api/model/providers` → `ProviderInfo[]`
  - `GET /api/model/providers/:id/models` → `ModelInfo[]`
  - `POST /api/model/discover`，请求体 `{provider, baseUrl, api?, apiKey?}` → `{models, total}`
  - `POST /api/model/test`，请求体 `{settings:PanelModel, apiKey?}` → `LastTest`
  - `PUT /api/model`，请求体 `{settings:PanelModel, apiKey?}` → `{ok:true, settings, keys}`
  - `PUT /api/account`，请求体 `{expectedHandle}` → `{ok:true, expectedHandle}`
  - `type LastTest = {ok:boolean; at:number; latencyMs:number; provider:string; id:string; input?:number; output?:number; error?:string}`，持久化在 store 的 runtime 键 `model:lastTest` 下。
  - 导出：`export function registerModelRoutes(app:FastifyInstance, deps:{store:Store; control:()=>string; run?:typeof runCompletion; discover?:typeof discoverModels}):void`
- 规则：
  - 校验失败返回 400 `{error}`。
  - `discover` 和 `test` 共用一个"进行中"标志，忙时返回 409 `{error:'已有请求进行中'}`。
  - 请求里没有 `apiKey` 时，按 `keySlot(provider, baseUrl)` 读取已保存的 Key；读不到就返回 400 `{error:'请先填写 API Key'}`。
  - `PUT /api/model` 的校验：
    - `checkBaseUrl` 必须通过；
    - 内置服务商必须在 `listProviders()` 里；
    - `id` 不能为空；
    - `maxTokens` 和 `timeoutMs` 在全局约束的范围内，并且 `maxTokens` 不超过模型 `info.maxTokens`；
    - `reasoningLevel` 必须在 `info.levels` 里。认不出的 custom 模型：`custom.reasoning` 为 true 时可选 `['off','low','medium','high']`，否则只能是 `['off']`。
  - `PUT /api/model` 读取已有设置时用 `readPanelSettings({tolerant:true})`，这样文件损坏时保存一次就能修好。
  - `PUT /api/account`：control 为 `running` 时返回 409 `{error:'先暂停'}`；空字符串表示删除 `expectedHandle`。
  - 写入日志的事件：`model-save`、`model-test`、`model-discover`、`account-save`。说明里只写服务商、模型 id、结果和耗时；错误信息先经过 `redact`。

- [ ] **Step 1：写失败的测试** `test/model-routes.test.ts`。用 `Fastify()` 加 `registerModelRoutes` 和 `app.inject`，store 用临时 SQLite，`run` 和 `discover` 用桩函数代替：
  - 首次 `GET /api/model`：`source==='config'`、`settings===null`。
  - `PUT /api/model` 保存一个 custom 配置（`baseUrl:'http://mock.local/v1'`，id `my-model`）并带上 `apiKey:'sk-test-123456789'` → 200；之后 `GET /api/model` 的 `keys['custom@mock.local']==='••••6789'`，并且两次响应的原文都不包含 `sk-test-123456789`。
  - `PUT /api/model` 的 baseUrl 分别为 `http://localhost:1/v1`、`http://169.254.169.254/` 时返回 400；`maxTokens:9000` 返回 400；内置 deepseek 模型的 `reasoningLevel:'medium'` 返回 400（deepseek-flash 不支持这一档）。
  - 先把 `settings.json` 写成损坏的 JSON，再 `PUT /api/model` → 200，之后 `readPanelSettings()` 不再抛错。
  - `PUT /api/account`：`'@Role_Demo'` → `expectedHandle==='role_demo'`；`''` 之后 `readPanelSettings().expectedHandle===undefined`；`control` 为 `'running'` 时返回 409。
  - `POST /api/model/test`：
    - 桩函数返回 `stopReason:'length'` → `ok:true`；
    - 桩函数抛出 `Error('bad sk-test-123456789')` → `ok:false`，`error` 不含 Key；
    - `store.get('model:lastTest')` 能解析出这次的结果；
    - 同时发两个请求（桩函数等待 50ms）→ 状态码分别是 200 和 409。
  - `POST /api/model/discover`：对 `custom@other.example` 这个没有 Key 的槽位、请求里也不带 `apiKey` → 400 `/请先填写 API Key/`。
  - 保存之后 `store.logs()` 里有 `event==='model-save'` 的记录，并且所有记录的 detail 都不包含 Key。
- [ ] **Step 2：** 执行 `dev/sync.sh && dev/t.sh test/model-routes.test.ts`。预期 FAIL。
- [ ] **Step 3：** 实现 `src/model-routes.ts`，并修改 `src/app.ts`。`app.ts` 的改动不超过 10 行。
- [ ] **Step 4：** 执行 `dev/sync.sh && dev/t.sh`。预期全部 PASS。
- [ ] **Step 5：** 提交：`git commit -m "feat: model and account routes"`

### Task 6: Staging 环境与 E2E 测试框架

**Files:**
- Create：
  - `dev/staging/compose.yaml`，项目名 `role-workflow-panel`；
  - `dev/staging/proxy.mjs`；
  - `dev/staging/mock-model.mjs`；
  - `dev/staging-up.sh`；
  - `dev/e2e.sh`；
  - `test/panel-e2e.mjs`。
- 服务器：`/var/lib/role-workflow-panel/{app,config,secrets/app,secrets/proxy,artifacts}`。

**Interfaces:**
- Produces：
  - staging 地址 `http://127.0.0.1:8081`（服务器本机），以及通过 `ssh -N -L 8081:127.0.0.1:8081 dsh` 转发后的本机地址。
  - 模拟模型接口 `http://mock-model:8080/v1`，Key 为 `staging-key-0001`。它的 `/v1/models` 返回 `deepseek-flash` 和 `my-finetune-v2`，`/v1/chat/completions` 以 SSE 返回 `MODEL_OK`。
  - `test/panel-e2e.mjs` 导出用法：`check(name, async (page) => {...})`。每一项都在新的 context 里运行。结果写到 `/artifacts/panel-e2e.json`，内容为 `{checks:[], errors:[]}`。任意一项失败时退出码为 1。
- compose 里的三个服务：
  - `app`：从 `../..` 构建，target 用 `runtime`，镜像名 `role-workflow-app:panel-dev`。环境变量和生产一样，只是 `BROWSER_ENDPOINT=http://127.0.0.1:9`。挂载 `/var/lib/role-workflow-panel` 下对应的目录。设置和生产一样的 `read_only`、`tmpfs`、`cap_drop`。
  - `mock-model`：使用固定 digest 的 node 镜像，运行 `node /dev/mock-model.mjs`。
  - `proxy`：同一个 node 镜像，端口 `127.0.0.1:8081:8081`。注入 `x-ingress-key`（从 `secrets/proxy/ingress_key` 读取），**删除** `origin` 请求头，并支持 SSE 流式转发。

- [ ] **Step 1：** 在服务器上初始化数据目录：
  - 把 `config.example.json` 写入 `config/config.json`；
  - 生成 64 位十六进制的 `ingress_key`，分别写到 `secrets/app/` 和 `secrets/proxy/` 下；生成 `browser_key`；创建空的 `model_api_key`；
  - 用 `chown -R 1000:1000` 修改 `app`、`config`、`secrets` 的属主，文件权限设为 0600。
- [ ] **Step 2：** 写 compose、proxy、mock-model 和 `dev/staging-up.sh`（`cd /srv/role-workflow-panel && docker compose -f dev/staging/compose.yaml up -d --build`）。
- [ ] **Step 3：** 写 `test/panel-e2e.mjs` 框架，第一项检查是 `providers API`：`GET http://127.0.0.1:8081/api/model/providers` 返回 200，并且包含 id `deepseek`。再写 `dev/e2e.sh`。
- [ ] **Step 4：** 执行 `dev/sync.sh && ssh dsh /srv/role-workflow-panel/dev/staging-up.sh && dev/e2e.sh`。预期 `errors` 为空。另外执行 `ssh dsh docker compose -p role-workflow ps`，预期生产的两个容器仍是 `running`，并且 `Status` 和之前相同、没有重启。
- [ ] **Step 5：** 提交：`git commit -m "chore: staging stack and e2e harness"`

### Task 7: 前端骨架、顶栏与概览页

**Files:**
- Replace：`public/index.html`、`public/style.css`
- Delete：旧的 `public/app.js`
- Create：
  - `public/js/dom.js`：`h(tag, attrs, ...children)`，只用 textContent；
  - `public/js/api.js`；
  - `public/js/state.js`；
  - `public/js/app.js`；
  - `public/js/views/overview.js`。
- Test：`test/panel-e2e.mjs`，在这里添加检查项。

**Interfaces:**
- Produces（前端模块之间）：
  ```js
  // api.js
  export async function api(path, {method='GET', body, timeoutMs=15000}={}) // 非 GET 自动加 X-Workflow-Control:1；非 2xx 时抛出 Error(json.error || 'HTTP '+status)
  export function control(action) // 调用 api('/api/control/'+action, {method:'POST', timeoutMs:120000})
  // state.js
  export function onStatus(fn) /* 返回取消订阅函数 */; export function refreshStatus(); export function onLogs(fn); export function notice(text, kind='info'|'error')
  // 每个视图
  export function mount(root, ctx) /* 返回 unmount() */
  ```
- DOM id（E2E 测试依赖这些）：
  - 顶栏：`#status-pill`、`#primary-action`、`#notice`，页签 `a[href="#/overview"]`、`a[href="#/model"]`、`a[href="#/browser"]`；
  - 概览页：`#run-state`、`#unknown-count`、`#handle-input`、`#handle-save`、`#handle-use-current`、`#model-summary`、`#logs`，每条日志是一个 `li`。
- 规则：
  - 状态每 10 秒轮询一次。日志通过 SSE 订阅，收到后整体替换列表。
  - 主按钮的映射照设计 6.1 的表格。
  - 预期账号的输入框在 control 为 running 时禁用，并显示"先暂停"。
  - "用当前登录"只在 `browser.loggedIn` 为真时可用。浏览器登录的账号和预期账号不一致时，账号卡片显示醒目的警告。
  - 运行卡片的内容按设计 6.1：
    - `stats.messages` 里 `status==='unknown'` 的数量大于 0 时，在 `#unknown-count` 显示"N 条发送结果待回查"；
    - `cooldown.public` 或 `cooldown.private` 大于当前时间时，显示对应通道的退避截止时间。
  - 模型卡片挂载时请求一次 `GET /api/model`，显示 `info.name`（没有就显示 id）、Base URL 的主机名和 `lastTest`。

- [ ] **Step 1：写失败的 E2E 检查项**：
  - `overview loads`：打开 `/#/overview` 后，`#status-pill` 的文本为"已暂停"，`#primary-action` 的文本为"恢复处理"；
  - `resume needs handle`：点击 `#primary-action` 后，`#notice` 包含"预期 X 账号"；
  - `handle save/clear`：填入 `@Role_Demo` 并保存，刷新后 `#handle-input` 的值为 `role_demo`；清空并保存，刷新后值为空；
  - `logs render`：`#logs li` 的数量大于等于 1；
  - `theme`：调用 `emulateMedia({colorScheme:'dark'})` 前后，`getComputedStyle(document.body).backgroundColor` 不同，两种配色各截一张图；
  - `mobile`：视口设为 375×800，`scrollWidth<=375`。
- [ ] **Step 2：** 执行 `dev/sync.sh && ssh dsh /srv/role-workflow-panel/dev/staging-up.sh && dev/e2e.sh`。预期新加的检查项 FAIL。
- [ ] **Step 3：** 实现骨架、顶栏和概览页。视觉上参照样稿 `layout-v3.html`，并照设计 6.1 定义浅色和深色两套 CSS 变量。
- [ ] **Step 4：** 再跑同一条命令。预期 `errors` 为空，并且 `dev/t.sh` 也全部通过。
- [ ] **Step 5：** 提交：`git commit -m "feat(panel): shell, top bar and overview"`

### Task 8: 模型页

**Files:**
- Create：`public/js/views/model.js`，`public/js/views/model-form.js`（纯函数：表单状态与请求体的转换、槽位计算、数字格式化）
- Modify：`public/style.css`
- Test：`test/panel-e2e.mjs`，在这里添加检查项。

**Interfaces:**
- Consumes：Task 5 的 HTTP 接口，Task 7 的 `api`、`notice`、`h`。
- DOM id：
  - 服务商：`#provider-select`（按钮）、`#provider-list`（选项带 `[data-provider=<id>]`，有搜索框 `#provider-search`）；
  - 地址、协议、Key：`#base-url`、`input[name=api]`（只在 custom 时显示）、`#api-key`、`#key-state`；
  - 模型：`#model-input`、`#model-list`（选项带 `[data-model=<id>]`，有搜索框 `#model-search`）、`#discover`、`#model-info`；
  - 推理与高级：`input[name=reasoning]`、`#max-tokens`、`#timeout`；
  - 操作：`#test`、`#save`、`#test-result`、`#confirm-save`（页内确认条）。
- 规则：
  - 上下文长度的显示格式：≥1,000,000 显示为 `${n/1e6}M`，否则显示为 `${Math.round(n/1000)}K`。
  - 切换服务商，或者 Base URL 的 hostname 发生变化时，清空 `#api-key`。
  - `#key-state` 按当前槽位显示：
    - 有已保存的 Key：显示"已设置 ••••xxxx"；
    - 主机变了，并且原来的槽位有 Key：显示"地址的主机变了，请重新填写 Key"；
    - 其他情况：为空。
  - 本次修改后没有测试过，或者最近一次测试失败时，点击保存会显示 `#confirm-save`，文案为"未通过测试，仍要保存吗"。
  - 推理档位按 `info.levels` 显示；默认选 `off`，没有 `off` 时选第一档。
  - 选中一个内置模型时：如果用户没有手动改过 `#base-url`，就把它改成这个模型的 `info.baseUrl`（多 baseUrl 的服务商靠这条规则选对地址）。
  - `#model-input` 允许直接手输模型 id。
  - custom 服务商下，模型认不出来时，`#model-info` 里出现可编辑的 `#custom-context`（默认 128000）和 `#custom-reasoning`（默认不勾选），值写进 `settings.custom`。
  - 有未保存的修改时：
    - 切到其他页签，显示页内的 `#confirm-leave`（"有未保存的修改，确定离开吗"，带"离开"和"留下"两个按钮）；
    - 关闭或刷新标签页时，注册 `beforeunload`。

- [ ] **Step 1：写失败的 E2E 检查项**，都在 staging 上跑：
  - `provider list`：服务商列表里有 `[data-provider=deepseek]` 和 `[data-provider=custom]`，没有 `[data-provider=amazon-bedrock]`；
  - `builtin provider`：选 deepseek 后，`#base-url` 的值为 `https://api.deepseek.com`，`input[name=api]` 不可见，模型列表里有 `deepseek-flash`，选中后 `#model-info` 包含 `1M`；
  - `custom discover/test/save`：
    1. 选 custom，Base URL 填 `http://mock-model:8080/v1`，协议选 openai-completions，Key 填 `staging-key-0001`；
    2. 点 `#discover`，列表里 `deepseek-flash` 那一项包含"pi 已识别"，`my-finetune-v2` 那一项包含"需手填参数"；
    3. 选 `my-finetune-v2`，点 `#test`，`#test-result` 包含"通过"；
    4. 点 `#save`，`#notice` 包含"下一轮处理生效"，并且 `#status-pill` 仍然是"已暂停"（保存不改变运行状态）；
    5. 刷新页面后 `#key-state` 包含 `••••0001`，并且 `document.documentElement.outerHTML` 不包含 `staging-key-0001`。
  - `unknown model params`：custom 下选 `my-finetune-v2`，`#custom-context` 的值为 `128000`，`#custom-reasoning` 没有勾选。
  - `leave with unsaved changes`：修改 `#max-tokens` 后点 `a[href="#/overview"]`，出现 `#confirm-leave`；点"留下"后仍然停在 `#/model`。
  - `host change`：先在 `#api-key` 里填 `typed-0003`，再把 `#base-url` 改成 `http://other-host:8080/v1`。之后 `#key-state` 包含"地址的主机变了"，并且 `#api-key` 的值为空。
  - `typed key cleared on provider switch`：在 `#api-key` 里填 `typed-0002`，切换到 deepseek，`#api-key` 的值变为空。
  - `save without test`：改选另一个模型后直接点保存，出现 `#confirm-save`。
  - `big list`：mock-model 在 Base URL `http://mock-model:8080/big/v1` 下返回 1500 个模型，id 从 `m-0000` 到 `m-1499`。拉取后：
    - `#model-list` 的选项数量正好是 1000；
    - 在 `#model-search` 里输入 `m-0999`，正好筛出 1 项；
    - 输入 `m-1499`，筛出 0 项（超出 1000 的部分被截掉了）；
    - 整个过程没有超时。
- [ ] **Step 2：** 执行 `dev/sync.sh && ssh dsh /srv/role-workflow-panel/dev/staging-up.sh && dev/e2e.sh`。预期新加的检查项 FAIL。
- [ ] **Step 3：** 实现模型页，布局参照样稿 `model-v5.html`。
- [ ] **Step 4：** 再跑同一条命令。预期 `errors` 为空。
- [ ] **Step 5：** 提交：`git commit -m "feat(panel): model page"`

### Task 9: 浏览器页

**Files:**
- Create：`public/js/views/browser.js`
- Test：`test/panel-e2e.mjs`，在这里添加检查项。

**Interfaces:**
- DOM id：`#connect`（文案为"接管并连接"，manual 状态下为"连接桌面"）、`#release`（释放并断开）、`#desktop-frame`（iframe，只在连接后存在）、`#open-new-tab`。
- iframe 地址：`/desktop/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=desktop/websockify`。
- 规则：
  - 页面挂载时不创建 iframe。
  - 点"接管并连接"：先调用 `control('takeover')`，成功后再挂载 iframe。
  - 点"释放并断开"：先移除 iframe，再调用 `control('release')`，然后显示提示"处理保持暂停，可在右上角恢复"。
  - 离开浏览器页（unmount）时移除 iframe，不调用 release。

- [ ] **Step 1：写失败的 E2E 检查项**（staging 没有浏览器容器，所以接管一定会失败）：
  - `browser idle`：打开 `/#/browser` 后，页面包含"浏览器未连接"，`#connect` 的文案为"接管并连接"，页面上没有 `#desktop-frame`；
  - `connect failure stays disconnected`：点击 `#connect` 后，等 `#notice` 出现错误提示，页面上仍然没有 `#desktop-frame`，`#status-pill` 不是"人工接管中"。
- [ ] **Step 2：** 执行 `dev/sync.sh && ssh dsh /srv/role-workflow-panel/dev/staging-up.sh && dev/e2e.sh`。预期新加的检查项 FAIL。
- [ ] **Step 3：** 实现 `browser.js`，布局参照样稿 `layout-v2.html` 的第二部分。
- [ ] **Step 4：** 再跑同一条命令。预期 `errors` 为空。
- [ ] **Step 5：** 提交：`git commit -m "feat(panel): browser page"`

### Task 10: 生产只读验收脚本与 README

**Files:**
- Modify：`test/ui-acceptance.mjs`，按新的 DOM 重写；`README.md` 的"首次配置"一节以及提到模型配置的段落
- Create：`dev/prod-accept.sh`

**Interfaces:**
- `dev/prod-accept.sh`：用和现有验收相同的方式运行 `ui-acceptance.mjs`。
  - 镜像为 `role-workflow-browser:<当前版本>`，加上 `--network host`。
  - 挂载 `/var/lib/role-workflow/admin-access.txt:/run/test/admin-access.txt:ro`、`/var/lib/role-workflow/acceptance:/artifacts`，以及测试目录（只读）。
  - **测试目录挂载的是 `/srv/role-workflow/test`**，也就是 Task 11 合入之后的生产代码。

- [ ] **Step 1：** 重写 `ui-acceptance.mjs`：
  - 开头先读一次 `/api/status`。如果 `control` 不是 `paused`，就输出 `{"skipped":"control=<值>，只在暂停时验收"}` 并以退出码 2 结束，**不做任何点击**。
  - 检查项：
    - 三个页面都能加载，无脚本异常；
    - 浏览器页点"接管并连接"后，iframe 里的 noVNC 画布连上，判断条件照抄原脚本：`noVNC_connected`，并且画布颜色数大于 12；
    - 点"释放并断开"后，`#status-pill` 为"已暂停"，并且 `GET /desktop/vnc.html` 返回 423；
    - 模型页只打开、不点保存，`#provider-list` 里有 `deepseek`；
    - 浅色、深色各截一张图，存到 `/artifacts/`。
  - 原有的"未配置账号不能恢复"这一项改到 staging 上测（Task 7 已覆盖），生产上不再测。
  - 目标地址从环境变量 `PANEL_URL` 读取，默认是 `https://43.133.80.237`。
- [ ] **Step 1b：验证"运行中不验收"的保护。** 在服务器上起一个临时的桩服务：`GET /api/status` 返回 `{"control":"running"}`，并把收到的所有请求记下来。用 `PANEL_URL=http://127.0.0.1:<端口>` 运行 `ui-acceptance.mjs`。断言：退出码为 2，输出包含 `skipped`，桩服务没有收到任何 POST 请求。
- [ ] **Step 2：** 更新 README：
  - "首次配置"的第 3、4 步改为在面板里操作：概览页填预期账号，模型页选服务商、填 Key、测试、保存；
  - "日常命令"保持不变；
  - 说明面板设置存在 `/var/lib/role-workflow/app/panel/`，不进备份，恢复后需要重新填 Key。
- [ ] **Step 3：** 执行 `dev/t.sh`。预期全部 PASS，因为 README 和验收脚本都不参与单元测试。生产验收要等到 Task 11 才跑。
- [ ] **Step 4：** 提交：`git commit -am "test: production read-only acceptance; docs"`

### Task 11: 合入与发布（按设计 6.5a）

**Files:**
- 服务器：`/srv/role-workflow` 里会改动的文件——`public/` 全部、`src/settings.ts`、`src/model-catalog.ts`、`src/model-routes.ts`、`src/model.ts`、`src/config.ts`、`src/app.ts`、`src/types.ts`、`test/settings.test.ts`、`test/model-catalog.test.ts`、`test/discover.test.ts`、`test/model-routes.test.ts`、`test/ui-acceptance.mjs`、`README.md`。
- 服务器：`docs/协作-面板重做.md`
- **不合入**：`dev/`、`test/panel-e2e.mjs`。

- [ ] **Step 1：** 先读协作文件，看 GPT 有没有留言。有冲突就先停下，向用户报告。没有冲突就在文件里写上 `合入中 <ISO 时间>`。
- [ ] **Step 2：** 执行 `tar -czf /var/lib/role-workflow/releases/src-before-<版本号>.tgz -C /srv role-workflow --exclude role-workflow/node_modules`。版本号的算法：从 `docker images role-workflow-app --format '{{.Tag}}'` 里只取符合 `^[0-9]+\.[0-9]+\.[0-9]+$` 的标签（排除 `panel-dev`），用 `sort -V` 排序取最大的一个，再把最后一位加 1。
- [ ] **Step 3：** 把服务器上 `/srv/role-workflow` 的当前源码 rsync 到本地临时目录，和 `git show baseline` 逐个比较，列出 GPT 改过的文件。
  - 只有我改过的文件：直接用我的版本。
  - 只有 GPT 改过的文件：不动。
  - 双方都改过的文件：以 GPT 的当前版本为底，手工重新应用我在这个文件上的改动（可以用 `git diff baseline -- <file>` 看我的改动）。
- [ ] **Step 4：** 先把合并好的文件放进开发副本，执行 `dev/sync.sh && dev/t.sh`，预期全部 PASS；再跑一次 `dev/staging-up.sh && dev/e2e.sh`，预期 `errors` 为空。
- [ ] **Step 5：** 把 Files 里列出的文件复制进 `/srv/role-workflow`，然后执行 `cd /srv/role-workflow && deploy/upgrade.sh <版本号>`。预期构建时测试全部通过，最后输出"升级完成，服务保持暂停"。
- [ ] **Step 6：** 执行 `dev/prod-accept.sh`。预期 `checks` 包含全部检查项，`errors` 为空。
  - 如果结果是 `skipped`：说明处理正在运行，不要动它，向用户报告。
  - 如果失败：执行 `deploy/rollback.sh`，在协作文件里说明情况，然后向用户报告。
- [ ] **Step 7：** 在协作文件里写"已合入"，附上版本号、改动的文件清单和回滚方法，并复制一份到本地 GPT 副本的 `docs/`。停掉 staging：`docker compose -p role-workflow-panel down`，保留数据目录。
- [ ] **Step 8：** 本地提交：`git commit -am "release: merged into production <版本号>"`，并打标签 `release-<版本号>`。
