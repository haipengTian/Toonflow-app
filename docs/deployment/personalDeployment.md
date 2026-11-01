# 个人服务器镜像

应用源码在 `haipengTian/Toonflow-app` 维护，服务器部署文件在
`haipengTian/server-ops` 的 `toonflow/`。服务器只拉取镜像，不构建源码。

首版基于上游 `v2.0.9`，对应提交 `d7366e36ba30943cf308121c28011b45bbf922e0`。
个人发布标签为 `v2.0.9-custom.2`，镜像为
`ghcr.io/haipengtian/toonflow:2.0.9-custom.2`，目标平台为 Linux amd64。
发布标签不可复用；修改代码后递增 `custom.N`。

## 发布镜像

首次先在 GitHub 将 `HBAI-Ltd/Toonflow-app` fork 到 `haipengTian/Toonflow-app`，
启用 fork 的 GitHub Actions，再推送本地个人分支：

```bash
git push -u origin codex/toonflow-self-hosting
git tag v2.0.9-custom.2
git push origin v2.0.9-custom.2
```

以上命令在已提交个人部署改动后执行。标签触发 `Personal Docker image`，使用仓库自带的
`GITHUB_TOKEN` 发布 GHCR，无需把个人 Token 写入代码。
在分支上手动运行该 workflow 只构建，不发布镜像。

首次发布后检查 GHCR 的 `toonflow` 包可见性。公开镜像可由服务器匿名拉取；
私有包需在服务器自行执行 `docker login ghcr.io`，不要将凭据写进 Compose。
等待 Actions 成功，并从运行摘要取得镜像地址或 digest 后，再执行 server-ops 的安装步骤。

镜像复用上游 Dockerfile，包含 Bun 1.4.3、FFmpeg、内置节点、工具和 Web/Server。
`appVersion` 构建参数将应用展示版本设为上游版本；custom 发布号保留在镜像标签和 OCI 元数据中。
上游的桌面 Release workflow 已排除 `v*-custom.*`，个人标签不会触发各平台安装包和官方更新托管。

## 跟进上游

保留 `upstream` 指向 `https://github.com/HBAI-Ltd/Toonflow-app.git`。
在个人分支中合并选定的上游版本，解决冲突、构建并检查后，发布新的 custom 标签；
不自动把上游更新部署到服务器。每次变更都需要核对上游 Dockerfile 和运行环境要求。

## 服务器安装

按 `server-ops/toonflow/README.md` 操作。默认仅监听 `127.0.0.1:3014`，
通过主机 nginx 提供 `https://toonflow.thpvip.xyz`。项目、插件、素材和模型配置全部持久化在 `/opt/toonflow/app`。
`custom.2` 支持独立 server 的单管理员登录；桌面调用 `createApp` 默认保持原行为。

## 公网登录配置

使用 `server-ops/toonflow/setup-auth.sh` 在服务器终端交互设置密码。配置：

- `TOONFLOW_AUTH_ENABLED=true`：开启鉴权，缺少有效配置时拒绝启动。
- `TOONFLOW_PUBLIC_ORIGIN=https://toonflow.thpvip.xyz`：不带路径或末尾斜杠的来源地址。
- `TOONFLOW_AUTH_USERNAME=admin`。
- `TOONFLOW_AUTH_PASSWORD_HASH`：32 字节随机盐和 Node scrypt 默认参数生成的 64 字节密钥，格式为 `saltHex:keyHex`，不保存原始密码。

HTTPS 会话使用 `__Host-` Cookie（HttpOnly、Secure、SameSite=Strict），24 小时绝对过期；重启需要重新登录。
登录管理在首页侧栏，可退出当前浏览器；改密码后重建容器使所有会话失效。
写请求必须带与配置相同的 Origin，或同源 Referer；原有 MCP/A2A 客户端仍使用其各自有效 Bearer。
内部 MCP 应用操作使用进程随机凭据、loopback 和方法/路径白名单，不给公网 API 增加匿名旁路。
`/api/auth/session` 只返回鉴权开关和当前会话状态，健康检查还须确认匿名业务 API 返回 401。
反代保留公网 Host、设置 X-Forwarded-Proto；不把应用容器端口绑定公网。
登录入口不提供注册；这是私人管理员工作台，不是多租户服务。
