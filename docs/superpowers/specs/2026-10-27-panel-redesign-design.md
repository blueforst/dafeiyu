# 面板重做与模型配置 · 设计

> 当前后续开发计划：[X 自动回复 bot：七页面板与生产功能实施计划](../plans/2026-10-27-seven-page-production-bot.md)。本文保留为已交付三页面板的最初设计；本轮七页结构、人设／记忆编辑、定时发帖与计费要求以新计划为准，下述旧版“不做什么”不限制本轮已确认范围。

> 2026-10-27 更新：本文保留为最初设计记录。用户已明确不需要预期账号功能；0.1.12 已移除账号设置和对应限制，改用浏览器当前登录账号。当前行为以 README 与前端接口文档为准。
日期：2026-10-27
负责人：Claude，负责面板前端，以及模型配置和预期账号相关的后端代码。其余后端、部署脚本和验收工作仍由 GPT（Codex）负责。
相关文件：`docs/前端接口.md`（GPT 写的现有接口说明）、`README.md`。

---

## 1. 为什么做

现有面板只有一页，用户觉得太丑。更大的问题是模型只能 SSH 到服务器上配置：改 `config.json`，再把密钥写进 `secrets/app/model_api_key`。两者都以只读方式挂进容器，面板上只能看到模型名。

用户的要求：

- 整个面板可以重做。必须具备的功能只有两个：**模型配置**和**浏览器接管**。
- 模型配置要结合 pi 适配器（`@earendil-works/pi-ai@1.4.0`）。可以从 pi 的内置服务商里快速选择，Base URL 不用手填。协议、上下文长度这些参数由 pi 提供。也可以用 Base URL + API Key 从接口拉取模型列表。
- 不做订阅账号登录，只用 API Key。
- 浏览器单独一个界面，平时不连接。
- 模型配置也单独一个页面。

使用者是部署者本人（管理员），偶尔打开面板，做三件事：配模型、需要时接管浏览器登录 X、开始或暂停处理。面板在宿主 Nginx 的 HTTPS 和 Basic Auth 之后。

## 2. 目标

1. 三个页面：**概览 / 模型 / 浏览器**，顶部切换。运行状态和"恢复处理 / 暂停"按钮固定在右上角，每一页都能操作。
2. 模型页：
   - 可以选择 pi 内置服务商。选中后自动填好 Base URL，用户可以修改。
   - 协议、上下文、最大输出、推理档位、是否支持看图、价格，都来自 pi 的模型目录。
   - 可以用 Base URL + Key 拉取接口上的模型列表。
   - 支持"自定义"服务商（中转站、自建服务）：手填 Base URL，选择协议，拉到的模型如果能在 pi 目录里认出来，就带上目录里的参数。
   - 提供"测试连接"和"保存"。保存后下一轮处理生效，不用重启。
3. 预期 X 账号可以在面板上设置，并提供"用当前登录"一键填入浏览器当前登录的账号。
4. 浏览器页：平时不连接。点"接管并连接"后才连接 noVNC；点"释放并断开"后断开连接，处理保持暂停。
5. 观感要整洁，配色跟随系统的浅色 / 深色设置。

## 3. 不做什么

- 订阅账号或 OAuth 登录（Claude Pro/Max、ChatGPT、Copilot 等）。
- 需要额外参数的服务商：Amazon Bedrock、Azure、Cloudflare AI Gateway、Cloudflare Workers AI、Google Vertex。
- 只能 OAuth 登录的服务商：OpenAI Codex、GitHub Copilot。
- 非聊天模型：TypeSafe。
- 不在面板上编辑以下内容，它们仍在 `config.json` 里改：角色设定（persona）、今日状态、限速、轮询间隔、草稿 / 自动模式。
- 不在面板上查看或发送草稿。草稿含消息正文，现有约定是只在管理员终端查看。
- 不支持保存多套模型配置、一键切换。（我的决定）
- 不接入视觉输入。workflow 仍保持 `vision=false`，"看图"只作为模型信息展示。

## 4. 绝不能出现的情况

即使功能都能用，出现下面任何一条也算失败：

- API Key 被返回给浏览器、写进日志或错误信息，或者在页面上完整显示。
- 面板上的任何操作（保存模型、改账号）悄悄恢复了处理，或者打开了自动发送。
- 非人工接管状态下浏览器桌面能被连上。
- 覆盖或打乱 GPT 正在进行的后端工作，或者两边部署互相冲突。
- 面板依赖外部 CDN 或字体服务。所有静态资源都由本服务提供。（我的决定）

## 5. 约束（现状）

- **现有接口约定**见 `docs/前端接口.md`：
  - 所有 POST 请求必须带 `X-Workflow-Control: 1`，后端会校验 Origin。
  - 控制操作可能要等当前浏览器操作结束，客户端超时至少 110 秒。
  - 日志通过 SSE 推送（`/api/events`，每次推送最近 30 行的完整数组，前端整体替换）；另有 `/api/logs`（最近 100 行）。
  - 非 manual 状态访问 `/desktop/*` 返回 423。
  - 日志用纯文本渲染，禁止 innerHTML。
  - 状态为 `unknown` 的消息要显示为"发送结果待回查"。
  - "恢复处理"的文案不能写成"开启自动发送"。
- **容器**：
  - app 容器根文件系统只读，`/data` 可写（对应宿主机 `/var/lib/role-workflow/app`，属主是 uid 1000，即容器里的 `node` 用户）。
  - `/config` 和 `/run/role-secrets` 只读。
  - 内存上限 512 MB。
  - Fastify 请求体上限 16 KB，Nginx 上限 256 KB。
- **构建**：
  - 镜像构建时会跑 `npm run check`（tsc）和 `npm test`（node:test + tsx）。
  - 用 `deploy/upgrade.sh <版本号>` 发布固定版本：先暂停、再备份、再切换 `.env` 里的版本号，重启后保持暂停。
  - 当前运行的是 0.1.4，0.1.5 已构建。
- **协作**：
  - 服务器 `/srv/role-workflow` **没有 git**。
  - GPT 正在服务器上持续修改后端，并同步到本机 `role-workflow/`。
  - 所有构建、测试和渲染都在服务器上进行。
- **pi 内置目录**：42 个服务商。每个模型都带 `api`、`baseUrl`、`contextWindow`、`maxTokens`、`reasoning`、`thinkingLevelMap`、`input`（是否含 image）、`cost`、`compat`。
- **现有验收测试**：`test/ui-acceptance.mjs` 用的是旧面板的按钮文案和 DOM ID，改版后要同步修改，原有的行为断言必须保留：认证、接管、释放后阻断桌面、未配置账号时不能恢复。

## 6. 方案

### 6.1 页面与交互

**整体**

- 单页应用，用 hash 路由：`#/overview`、`#/model`、`#/browser`，默认进概览。
- 不用构建工具和框架：原生 HTML、CSS 和 JS 模块，`public/` 目录里的文件就是最终产物。（我的决定）
- 配色用 CSS 变量定义，通过 `prefers-color-scheme` 跟随系统。风格是中性的黑白灰：浅色主题用黑色主按钮，深色主题用近白色主按钮。状态色：暂停用琥珀色，运行用绿色，接管用蓝色，错误用红色。只用系统字体（含 PingFang SC 和 Microsoft YaHei）。
- 手机宽度下改为单列，不出现横向滚动。

**顶栏（所有页面）**

- 左侧是标题和三个页签。右侧是状态标签和一个主按钮，主按钮随状态变化：

| control | 状态标签 | 主按钮 |
|---|---|---|
| paused | 已暂停 | 恢复处理 |
| running | 处理中 | 暂停 |
| draining | 等待当前操作结束 | 禁用并显示进行中 |
| manual | 人工接管中 | 释放接管 |

- 控制请求进行期间，所有控制按钮都禁用，防止重复点击。失败（409）时把后端返回的中文 `error` 显示在顶栏下方的提示条里。
- 另有一个小的连接状态提示：API 是否可达、SSE 是否正在重连。

**概览页**（样稿：`layout-v3.html` 上半部分）

- **运行卡片**：
  - 大字显示状态，下面一行写模式。草稿模式写"只生成草稿，不发送"，自动模式写"自动回复"。
  - 显示最近一轮的时间、各通道排队数量、token 累计用量。
  - 如果有 `unknown` 状态的消息，醒目显示"N 条发送结果待回查"。
  - 某个通道在退避期时，显示退避截止时间。
- **X 账号卡片**：
  - 预期账号输入框和保存按钮。
  - "用当前登录"按钮：仅当浏览器已登录时可用，点击后用 `browser.handle` 填入并保存。
  - 显示浏览器登录状态，以及是否和预期账号一致；不一致时给出明显提示。
  - **只有不在 running 状态时才能修改**，运行中输入框禁用，并提示"先暂停"。（我的决定：避免改完下一轮就触发安全暂停）
- **模型卡片**：显示当前模型的名称和 id、Base URL 的主机名、协议、上次测试的结果和时间，以及"去配置 →"链接。配置有错误时显示 `configError`。
- **日志卡片**：
  - 通过 SSE 实时显示最近 30 行，每行有级别色点、时间、事件名和说明。
  - "查看更多"改为调用 `/api/logs` 拉 100 行。
  - 页面注明"只显示运行事件，不含消息正文"。

**模型页**（样稿：`model-v5.html`）

- 字段顺序：服务商 → Base URL → [仅自定义时显示：接口协议] → API Key → 模型 → 模型信息（只读）→ 推理强度 → 高级（回复长度上限、超时）→ 测试连接 / 保存。

- **服务商下拉框**：
  - 可以搜索，分"国内 / 海外 / 其他"三组，最后一项是"自定义"。
  - 每一项显示 pi 目录里的模型数量。
  - 分组名单写在前端或后端的常量里。国内组至少包括：deepseek、moonshotai-cn、zai-coding-cn、qwen-token-plan-cn、minimax-cn、xiaomi、xiaomi-token-plan-cn、ant-ling。
- **Base URL**：
  - 选内置服务商时，自动填入 pi 预设值，旁边标"pi 预设 · 可改"。
  - 服务商下有多个 baseUrl 时（比如 OpenRouter、Fireworks、OpenCode 按协议各有一个），以所选模型自己的 `baseUrl` 为准；用户手动改过的除外。
- **接口协议**：只在选"自定义"时显示，三选一：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages。内置服务商的协议直接用模型的 `api`。
- **API Key**：
  - 密码输入框。已保存过时显示"已设置 ••••末4位"和"更换"。
  - Key 按服务商分别保存，切回之前用过的服务商时，不用重新填写。
- **模型下拉框**：
  - 默认列出 pi 目录里该服务商的聊天模型，每项显示名称和 id，以及上下文、推理、看图三个标签。
  - "用 Key 拉取"按钮：用当前 Base URL 和 Key（新填的 Key，或者已保存的 Key）去接口查询，然后给模型标上"可用"。
  - 接口返回了、但 pi 目录里没有的模型，标"仅接口"并追加到列表里。
  - 自定义服务商的列表全部来自接口。每个 id 都去 pi 全部目录里精确匹配：匹配到的显示"pi 已识别"并带出参数，匹配不到的标"需手填参数"。
  - 也可以直接手输模型 id。
- **模型信息（只读）**：协议、上下文、最大输出、每百万 token 的价格（输入 / 输出），以及是否支持推理和看图。
  - 对认不出来的模型，上下文和推理两项变成可编辑，默认值是 128K、不支持推理。
- **推理强度**：
  - 按钮组的档位完全照 pi 的 `getSupportedThinkingLevels(model)` 显示。这个列表里有 `off` 就显示"关"；没有 `off` 说明这个模型只能开着推理调用，比如 GPT-5、Claude，这时不显示"关"。
  - 默认选"关"；不能关的模型默认选最低一档。
  - 模型不支持推理时整组隐藏。
  - 自定义服务商默认是"关"。
- **高级**（默认折叠）：
  - 回复长度上限 `maxTokens`：默认 1024，范围 64–8192，且不能超过模型的 `maxTokens`。
  - 超时：默认 60 秒，范围 1–180 秒。
- **测试连接**：
  - 用表单里**尚未保存**的设置，加上新填的 Key 或已保存的 Key，发起一次最小请求：系统提示"只输出 MODEL_OK"，`maxTokens` 设为 16，**关闭推理**。如果模型只能以推理方式调用，就用最低档推理，`maxTokens` 改为 2048。
  - 测试只检验连通性，也就是地址、Key、模型 id 是否正确。只要拿到了模型的回应就算通过，即使回应是因为长度用尽而截断的（`length`）也算。只有 `error`、`aborted` 或请求失败才算不通过。
  - 显示是否通过、耗时、输入 / 输出 token 数或错误信息。按钮旁注明"会产生少量费用"。
- **保存**：
  - 校验通过后写入。如果本次修改后还没测试过，或者最近一次测试失败，就弹出确认"未通过测试，仍要保存吗"。（我的决定）
  - 保存成功后提示"下一轮处理生效"。保存**不改变** control 状态。
- 离开页面时如果有未保存的修改，给出提示。

**浏览器页**（样稿：`layout-v2.html` 第二部分）

- 页面加载时**不连接**，不挂载 iframe。
- control 不是 manual 时：
  - 显示"浏览器未连接"，说明接管会先等当前操作结束、停止自动处理。
  - 提供"接管并连接"按钮。点击后调用 takeover，等待期间显示"等待当前操作结束…"。成功后挂载 iframe 并铺满页面。
- 打开页面时 control 已经是 manual：显示"人工接管中"和"连接桌面"按钮，**不自动连接**。
- 连接后：
  - 页面顶部显示"人工接管中 · 自动处理已停止"和"释放并断开"按钮。点击后先卸载 iframe，再调用 release，提示"处理保持暂停，可在右上角恢复"。
  - 另提供"新标签页打开"作为备用。
- 在 manual 状态下切到别的页签，iframe 会被卸载（连接断开），但 control 保持 manual。
- iframe 地址沿用：`/desktop/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=desktop/websockify`。

### 6.2 后端：设置存储

- **新增 `src/settings.ts`**，面板管理的设置都写在可写的 `/data` 下：
  - `/data/panel/settings.json`（权限 0600）：
    ```json
    { "expectedHandle": "role_demo",
      "model": { "provider": "deepseek | custom", "baseUrl": "…", "api": "仅 custom 时使用",
                 "id": "deepseek-flash", "reasoningLevel": "off | low | high | …",
                 "maxTokens": 1024, "timeoutMs": 60000,
                 "custom": { "contextWindow": 128000, "reasoning": false } } }
    ```
  - `/data/panel/model-keys.json`（权限 0600）：形如 `{ "<providerId 或 custom>": "<key>" }`。
  - 写入都采用"先写临时文件，再 rename"的原子方式。
- **合并规则**：`loadConfig()` 先读 `config.json`，如果存在 `settings.json`，就用其中的 `expectedHandle` 和 `model` **覆盖** `config.json` 的对应字段，其余字段仍以 `config.json` 为准。合并后的结果仍然要通过现有的校验。`/api/status` 增加 `config.model.source: "panel" | "config"`。
- **Key 和"服务商 + Base URL 主机"绑在一起**（我的决定，防止 Key 被发到别的主机）：
  - `model-keys.json` 的键名是 `<providerId>@<baseUrl 主机名>`。自定义服务商同理，写成 `custom@<主机名>`。
  - 在页面上改了 Base URL 的主机后，原来的 Key 不会跟过去，页面提示"地址的主机变了，请重新填写 Key"。
  - `keySet` 和 `keyHint` 都按当前的"服务商 + 主机"计算。
  - 测试连接、拉取列表时也只会用到与当前地址匹配的 Key。
- **旧 Key 文件**（`/run/role-secrets/model_api_key`）**只在模型配置来自 `config.json` 时使用**，也就是面板从来没保存过模型的时候。面板配置的模型一律不读它。
- **`redact()` 要扩展**：面板保存的所有 Key 都要能被打码，不能只认识 `/run/role-secrets` 下的那几个文件。
- **备份**：现有 `backup.py` 只备份 SQLite，所以 Key 不会进入备份。从备份恢复后需要重新填 Key，这是可接受的。不改 compose.yaml 的挂载。

### 6.3 后端：pi 目录与调用

- **新增 `src/model-catalog.ts`**：
  - 首次被调用时才加载 `@earendil-works/pi-ai/providers/all`，加载后缓存在内存里。
  - **可选服务商的过滤规则**：auth 里有 apiKey；baseUrl 不含 `{` 占位符且不为空；排除 amazon-bedrock、openai-codex、github-copilot、typesafe；至少有一个聊天模型。按 6.1 的分组输出。
  - **拉取接口模型列表**：根据协议决定请求方式。
    - openai-completions / openai-responses / mistral：请求 `GET {baseUrl}/models`，带 `Authorization: Bearer`。
    - anthropic-messages：请求 `GET {baseUrl}/v1/models`（baseUrl 已经以 `/v1` 结尾时不再重复），带 `x-api-key` 和 `anthropic-version`。
    - google-generative-ai：请求 `GET {baseUrl}/models?key=`。
    - 超时 15 秒，最多返回 1000 个。
    - 每家的路径细节由实现者逐个核对（比如 DeepSeek 的 baseUrl 不带 `/v1`）。
  - **构造运行时模型**：
    - 内置服务商：从目录里取出模型；如果用户改过 Base URL，就覆盖 baseUrl；调用时显式传入 apiKey。
    - 目录里没有、但接口返回了的 id：以这家服务商的任意一个目录模型为模板（沿用 api、baseUrl、compat），把 id 换掉，参数用保守默认值。
    - 自定义服务商：沿用现在 `createProvider` 的写法，使用用户选的 api。如果 pi 目录里能匹配到这个 id，**只**借用 `contextWindow`、`maxTokens`、`reasoning`、`input`，**不**借用 `compat`。
- **`src/model.ts` 的 `PiGenerator` 改为调用上面这些函数**，pi 支持的协议都可以用，不再只限三种。输出的约束保持不变：`parseDraft`、长度检查、stopReason 检查。
- **`maxTokens` 只管可见回复的长度**（我的决定）：
  - 配置里的 `maxTokens`（64–8192，`config.ts` 的校验不变）只限制看得见的回复长度。
  - 打开推理时，实际请求的上限 = 回复上限 + 推理预算，再取它和模型 `maxTokens` 中较小的一个。
  - 推理预算按档位取值：low 2048、medium 4096、high 8192，更高的档位 16384。实现者应优先使用 pi `completeSimple` 自带的推理预算处理。
  - Anthropic 要求推理预算至少 1024，并且小于 `max_tokens`，实现时要满足这个要求。
- **Base URL 的限制**：只允许 http 或 https，URL 里不能带账号密码；禁止指向主机名 `browser`、`app`、`localhost` 或 127.0.0.0/8，以及 169.254.0.0/16（云厂商元数据地址）。局域网地址允许，方便接入自建服务。（我的决定）

### 6.4 后端：新接口

现有的认证钩子已经覆盖所有路由：要求 Ingress Key，非 GET 请求要求 `X-Workflow-Control: 1`，并校验 Origin。下面这些新接口都在这个保护之下。

| 方法与路径 | 作用 |
|---|---|
| GET `/api/model` | 当前生效的模型设置和来源，`keySet` 与 `keyHint`（只给末 4 位，按服务商分开），最近一次测试结果。**绝不返回 Key。** |
| GET `/api/model/providers` | 可选服务商列表：id、名称、分组、默认 baseUrl、协议、模型数量。 |
| GET `/api/model/providers/:id/models` | 该服务商在 pi 目录里的聊天模型及参数。 |
| POST `/api/model/discover` | `{provider, baseUrl, api?, apiKey?}`，返回接口模型列表，并标出每个模型是否在 pi 目录里、带出匹配到的参数。 |
| POST `/api/model/test` | `{settings, apiKey?}`，用未保存的设置做一次最小请求，返回 ok、耗时、token 数或错误。 |
| PUT `/api/model` | `{settings, apiKey?}`，校验后保存设置；带了 apiKey 时同时写入该服务商的 Key。 |
| PUT `/api/account` | `{expectedHandle}`，去掉 @、转小写，按 `^[a-z0-9_]{1,15}$` 校验。传空字符串表示清除面板上设置的值，回退到 `config.json`。control 为 running 时返回 409。 |

- `discover` 和 `test` 同一时间只允许执行一个，第二个请求返回 409 "已有请求进行中"，避免误触重复计费。
- 写入日志的事件：`model-save`、`model-test`、`model-discover`、`account-save`。日志里只记服务商、模型 id、结果和耗时，不记 Key，错误信息先打码。
- 最近一次测试结果存在 runtime 表里，键名 `model:lastTest`。

### 6.5 与 GPT 的分工

- **Claude 负责**：
  - `public/` 下的全部文件；
  - 新增文件：`src/settings.ts`、`src/model-catalog.ts`、`src/model-routes.ts`；
  - 重写 `src/model.ts`；
  - 新增测试 `test/model-settings.test.ts`；
  - 修改 `test/ui-acceptance.mjs` 里的元素定位；
  - README 里"首次配置"一节和模型相关的段落。
- **共享文件只做最小改动**：
  - `src/config.ts`：让 `loadConfig` 合并面板设置，扩展 `redact`；
  - `src/app.ts`：注册路由，给 status 增加字段；
  - `src/types.ts`：增加模型相关字段。
  - 动这几个文件之前先在 `docs/` 里告知 GPT。
- **其余都归 GPT**：`browser.ts`、`workflow.ts`、`store.ts`、`transport.ts`、`cli.ts`、`deploy/`、`compose.yaml`、`Dockerfile`、Nginx。
- 开发时不直接改 `/srv/role-workflow`：在服务器上另开一个副本目录开发和测试，完成后再一次性合入。（我的决定）
- **测试环境（staging）**（我的决定）：
  - 代码副本放在 `/srv/role-workflow-panel`，用一个独立的 compose 文件，项目名是 `role-workflow-panel`。
  - 只运行三个容器：app、一个模拟模型接口（主机名 `mock-model`，符合 Base URL 规则），以及一个小反向代理。代理监听 `127.0.0.1:8081`，负责注入 staging 自己的入口凭据，并处理 Origin 校验。
  - 数据放在 `/var/lib/role-workflow-panel/`，和生产完全分开。不启动浏览器容器，所以 staging 上的浏览器状态会显示为不可用。
  - 通过 SSH 隧道访问。不改动生产的 compose、Nginx 或数据。

### 6.5a 合入与发布（用户决定：由 Claude 合入并发布）

- **协作文件**：新建 `docs/协作-面板重做.md`（本机和服务器各一份，以服务器上那份为准），作为和 GPT 之间的留言板。
  - GPT 已被告知：在 Claude 留言"已合入"之前，不要修改 `src/config.ts`、`src/app.ts`、`src/types.ts`、`src/model.ts` 这四个文件。确实要改的话，先写进这个文件。
  - GPT 发布新版本之前，要先看这个文件里有没有"合入中"的标记。
- **合入步骤**：
  1. 在协作文件里写"合入中"和开始时间。
  2. 把 `/srv/role-workflow` 当前的源码和开发开始时保存的快照做比较，找出 GPT 在此期间改过的文件，逐个手工合并，不整体覆盖。
  3. 合并之前，先把整个 `/srv/role-workflow` 打包备份到 `/var/lib/role-workflow/releases/src-before-<版本号>.tgz`。
- **版本号**：取服务器上现有 `role-workflow-app` 镜像的最大版本号加 1。用 `deploy/upgrade.sh <版本号>` 发布，发布后处理保持暂停，这是这个脚本本来的行为。
- **发布后**：
  1. 在生产上跑只读的界面验收，截图。
  2. 在协作文件里写"已合入"，附上版本号、改动的文件清单、回滚方法（`deploy/rollback.sh`）。
- 如果生产验收失败，就用 `rollback.sh` 回到上一个版本，再到协作文件里说明情况。

### 6.6 测试与验收

- **单元测试**：沿用现有的 node:test + tsx，在镜像构建时运行。覆盖：
  - 设置合并的优先级；
  - GET 接口的响应里不出现 Key；
  - 校验规则；
  - 服务商过滤；
  - 拉取列表的解析：针对每种协议，用本地模拟 HTTP 服务测试；
  - `redact` 能打码新 Key；
  - 对内置模型、自定义模型、未知 id 三种情况，`PiGenerator` 构造出正确的请求。用本地模拟的 openai-completions 服务验证。
- **界面验收**：在服务器上用 Playwright 跑，分两部分。
  - **会改数据的检查只在 staging 上跑**：
    - 模型页能列出服务商；
    - 自定义服务商能对 `mock-model` 拉取模型列表、测试并保存；
    - 保存后 GET 接口的响应里没有 Key；
    - 主机变了以后 Key 不会被沿用；
    - 预期账号能保存，也能清除；
    - 未配置账号时不能恢复。
  - **"运行中不能修改预期账号"放在单元测试里**：把 control 设成 running，验证接口返回 409。e2e 测试不去真的恢复处理。
  - **生产上只跑不改数据的检查**（也就是改造后的 `ui-acceptance.mjs`）：
    - 三个页面都能加载；
    - 从浏览器页接管后能连上画布；
    - 释放后桌面返回 423；
    - 模型页只读打开，不保存。
  - 浅色和深色各截一张图，存到 `/artifacts/`。
- **用户验收**：填入真实 Key，在页面上点"测试连接"，然后保存，再在服务器上跑 `cli.js model-check`。

## 7. 样稿

样稿在本机 `/Users/forst/code/server/.superpowers/brainstorm/84244-1793090954/content/`：

- `layout-v3.html`：三页结构和概览页（已认可）；
- `model-v5.html`：模型页（已认可）；
- `layout-v2.html` 第二部分：浏览器页的两种状态（已认可）。

样稿只用来表达布局和信息，具体样式由实现者把握。

## 8. 交给实现者决定的事

- 具体的视觉细节、组件拆分、JS 模块怎么组织。
- 每家服务商拉取模型列表时的具体路径和兼容处理。
- 国内 / 海外分组名单之外的细节，服务商的中文显示名称。
- 自定义服务商对认不出来的模型用什么默认值，在保守的前提下自行决定。
- 日志的"查看更多"怎么交互。

## 9. 待定问题

无。审阅者提出的四个问题都已处理：

- 测试环境：见 6.5 和 6.6，我的决定。
- 合入与发布：见 6.5a，用户决定。
- Key 绑定主机：见 6.2，我的决定。
- 推理时的长度上限和测试连接的标准：见 6.1 和 6.3，我的决定。
