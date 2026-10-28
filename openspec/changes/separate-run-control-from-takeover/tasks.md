# 顶部运行状态与浏览器接管分离实施任务

当前完成 6/7 项：独立界面 6/6 组／二十张截图、面板回归 25/25、真实隔离 noVNC 界面 6/6 均通过；生产脚本只做语法检查，生产发布仍未完成。规格见 [panel-navigation](specs/panel-navigation/spec.md) 与 [activity-feed](specs/activity-feed/spec.md)，实现边界见 [design.md](design.md)。界面验收只在服务器隔离环境执行，不使用生产 profile；生产发布需要另行授权。实施前确认本机工作副本中 `public/style.css` 等文件上其他人的未提交改动，不得覆盖。

## 1. 前端

- [x] 1.1 顶部栏按 design.md 第 1 节的状态表改写 `public/index.html` 和 `public/js/app.js`：保留 `#status-pill`、`#primary-action`，新增 `#takeover-link`，接管期间“启动”不可用并带说明。验收：服务器隔离 Camoufox 验收覆盖五种状态的状态、按钮和链接，以及点击链接打开并展开浏览器接管分区。
- [x] 1.2 浏览器接管分区（`public/js/views/browser.js`、`public/js/views/settings.js`）：在已接管未连接和已连接两种视图里加“释放接管”，分区标题行摘要随状态变化。验收：Camoufox 验收覆盖接管、连接桌面、在分区里释放、释放后处于已暂停且桌面入口返回 423、顶部“启动”恢复可用。
- [x] 1.3 按 design.md 第 3 节修改提示文案（`public/js/state.js`、`public/js/views/tasks.js`）。验收：Camoufox 验收确认启动、释放后的提示文字。
- [x] 1.4 窄屏和主题。验收：1440px 与 375px、浅色与深色截图；375px 下无整体横向滚动，接管期间顶部内容完整可见。

## 2. 验收脚本与文档

- [x] 2.1 更新 `test/panel-e2e.mjs`、`test/ui-acceptance.mjs`、`test/production-five-pages.mjs` 中依赖顶部“恢复处理”“释放接管”的步骤，改为在接管分区释放。验收：前两个脚本在服务器隔离环境跑通；`production-five-pages.mjs` 只做语法检查，不对生产运行。
- [x] 2.2 `docs/Camoufox浏览器.md` 改为在“设置 → 浏览器接管”分区接管和释放。验收：文档与实现一致。

## 3. 发布

- [ ] 3.1 取得发布授权后按现有流程发布。发布后只读打开面板，确认顶部显示“已暂停”和“启动”；验收期间不点击启动，也不接管。验收：发布记录；提案创建不视为发布授权。

## Workflow follow-up

- 本提案修改的“全局控制与配置保存”来自未归档的 `add-seven-page-production-bot`，“浏览器人工接管”和“首页概况行”来自未归档的 `simplify-panel-activity-feed`，归档时需要排在它们之后。
- OpenSpec 严格校验通过只代表规划结构可用，不勾选任何业务任务。
