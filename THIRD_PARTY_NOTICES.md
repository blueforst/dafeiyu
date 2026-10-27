# 第三方来源

- 浏览器桌面设计参考：[runzhliu/deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker/tree/833d60e772635a13c799c296730428c984312e58)，MIT。
- seccomp 原始配置：[Microsoft Playwright v1.64.1](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json)，Apache-2.0；本项目增加 Chromium 用户命名空间沙箱需要的 chroot 规则。
- 模型适配：[Pi AI](https://github.com/badlogic/pi-mono/tree/main/packages/ai)，以安装包中实际 LICENSE 为准。
- Chromium、noVNC、Xvfb、Openbox、x11vnc、websockify 由 Debian 包安装，许可证位于镜像 /usr/share/doc。
- Fastify、Playwright Core、twitter-text 等 JavaScript 包保留各自 npm 发行物及许可证。
