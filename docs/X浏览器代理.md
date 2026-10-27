# X 浏览器专用出口

当前状态：2026 年 10 月 27 日已按用户要求移除服务器 Bitz 节点。生产浏览器恢复服务器直连，节点凭据及代理状态目录已删除；本机 Clash 订阅保持原样。以下内容保留为无节点凭据的可选部署说明，不代表当前启用代理。

通过可选的 `compose.x-proxy.yaml` 增加 Mihomo 服务。业务镜像和宿主路由不需要调整。浏览器使用 HTTP 代理入口，Mihomo 将浏览器的 HTTP(S) 请求交给一个固定节点，包括 X 页面及登录验证资源。

## 配置与隔离

- Mihomo 镜像固定为官方 v1.19.33 及摘要，浏览器需要 0.1.6 或更新版本。
- 节点配置只保存在服务器 `/var/lib/role-workflow/secrets/x-egress/config.json`，权限为 0600、所有者 1000:1000。父目录为 0700。不要提交、展示或复制到交付资料。
- 配置采用一个固定节点，规则为 `MATCH,X-OUTBOUND`。节点不可用时浏览器请求失败，不自动切回服务器直连，也不自动切换国家。
- 代理入口只在独立 Docker 网络中监听，未发布宿主端口。管理接口为 `/var/lib/role-workflow/x-egress/controller.sock`，不开放 TCP 管理端口。
- 仅浏览器加入代理网络。业务服务未配置代理，模型请求、SSH、Nginx 和 noVNC 不经过 Bitz。
- 代理状态目录 `/var/lib/role-workflow/x-egress` 的所有者为 1000:1000、权限为 0700。

配置文件可以使用 JSON 或 YAML。仅复制计划使用的节点；无需保存整条订阅链接。代理组名称为 `X-OUTBOUND`，节点的 UUID、密码等由该私密文件管理。HTTP 入口不在浏览器代理 URL 中携带上游凭据。

## 启用

1. 确认业务暂停，并备份 `.env` 和浏览器资料。
2. 创建私密节点配置，使用固定镜像的 `-t` 参数检查配置。
3. 在服务器 `.env` 中设置：

   ```dotenv
   ROLE_VERSION=0.1.4
   APP_VERSION=0.1.4
   BROWSER_VERSION=0.1.8
   COMPOSE_FILE=compose.yaml:compose.x-proxy.yaml
   ```

4. 执行 `docker compose up -d browser-egress browser`。浏览器会重建，远程桌面短暂断开。
5. 浏览器健康后重新执行人工接管，使业务与浏览器控制状态保持一致，再连接远程桌面。
6. 分别验证真实浏览器出口、X 登录页连通，以及代理故障时的请求失败行为。页面可达不等于登录限制已经解除。

应用不因代理接入而恢复处理，草稿模式保持原样。

## 人工诊断窗口

业务浏览器受 Playwright 管理。如需沿用已有的独立人工登录目录，在浏览器容器中执行 `/app/open-manual-browser.sh`。该脚本使用同一个 `BROWSER_PROXY_SERVER`，并检查入口地址格式。默认配置目录为 `/profile/manual-login-check`。

独立窗口的登录状态不会自动同步给业务浏览器。登录成功后，应先核对账号，再在暂停状态下规划接回业务浏览器；不要复制单个 Cookie 到聊天或日志。

## 回滚

保持业务暂停，恢复变更前的 `.env`，执行 `docker compose up -d --no-deps browser` 以恢复原浏览器镜像和网络设置，然后删除代理容器。浏览器资料、数据库及发送回执不随镜像回滚删除。最后重新执行人工接管并确认状态。

本机 Clash 中访问服务器 IP 的直连规则与本方案分别管理；本方案不修改该规则。

## 参考

- [Mihomo 官方配置说明](https://wiki.metacubex.one/config/general/)
- [Mihomo 官方版本](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)
- [Playwright 浏览器代理选项](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context-option-proxy)
