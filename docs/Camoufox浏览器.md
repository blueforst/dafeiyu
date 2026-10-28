# Camoufox 浏览器

业务浏览器固定使用 Camoufox，已移除 Chromium 和浏览器构建选项。应用内部 API、人工接管和 noVNC 桌面接口沿用原有形式。

## 构建与版本

所有构建和运行测试在服务器执行：

```sh
docker build --target runtime -t role-workflow-app:版本号 .
docker build --target browser -t role-workflow-browser:版本号 .
```

Camoufox 启动器锁定 `0.5.8`，浏览器为配对的 `156.0.1-beta.36`，控制协议依赖独立的 Playwright `1.62.0`。主应用依赖不随浏览器更换降级。浏览器、模型数据均在构建时下载并准备完成，运行时字体缓存写入 tmpfs。

生产浏览器和验收程序均使用 Camoufox。镜像不安装 Chromium，人工诊断脚本也使用 Camoufox。

## 配置与接管

浏览器使用 `/profile/camoufox`，设备预设写入 `device-preset.json` 并在重启后复用。预设损坏时停止启动。启动脚本在同一 profile 的独占锁内处理崩溃遗留锁，保留非 root、只读根文件系统、capabilities 清空及 seccomp 限制。

通过面板“设置 → 排查问题 → 浏览器接管”分区接管并连接，也在该分区点击“释放接管”关闭桌面访问；释放后处理保持暂停，可在顶部点击“启动”。接管期间顶部显示“已暂停”，并提供“浏览器接管中 →”链接返回该分区，顶部“启动”暂不可用。健康接口返回 `engine: camoufox` 和实际版本。

## 验证

```sh
sh dev/browser-engine-test.sh role-workflow-browser:版本号
```

检查实际 Firefox 内核、非 root 运行、模拟消息解析、模拟 Cookie/localStorage 重启持久性、设备预设与可见设备字段稳定性，以及预设损坏时拒绝启动。面板验收验证真实 noVNC 画布、人工接管和释放后的 423。

隔离试验中曾进入 X 的账号密码输入页，期间也出现过“无法登录或稍后再试”。切换生产后，用户已自行完成登录，接口可识别当前账号；这不等于已验证长期登录稳定性或真实消息收发。自动处理仍保持暂停。

## 空间与更新

按用户要求，升级不自动打包源码、数据库或浏览器目录，也不保留旧镜像。源码由 Git 管理。`deploy/rollback.sh 版本号` 只切换到已存在的镜像；旧镜像清理后需从对应 Git 提交重新构建。

参考：[Camoufox 官方 TypeScript 启动器](https://github.com/daijro/camoufox/tree/main/typescript)。
