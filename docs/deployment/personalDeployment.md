# 个人服务器镜像

应用源码在 `haipengTian/Toonflow-app` 维护，服务器部署文件在
`haipengTian/server-ops` 的 `toonflow/`。服务器只拉取镜像，不构建源码。

首版基于上游 `v2.0.9`，对应提交 `d7366e36ba30943cf308121c28011b45bbf922e0`。
个人发布标签为 `v2.0.9-custom.1`，镜像为
`ghcr.io/haipengtian/toonflow:2.0.9-custom.1`，目标平台为 Linux amd64。
发布标签不可复用；修改代码后递增 `custom.N`。

## 发布镜像

首次先在 GitHub 将 `HBAI-Ltd/Toonflow-app` fork 到 `haipengTian/Toonflow-app`，
启用 fork 的 GitHub Actions，再推送本地个人分支：

```bash
git push -u origin codex/toonflow-self-hosting
git tag v2.0.9-custom.1
git push origin v2.0.9-custom.1
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
通过 SSH 隧道访问。项目、插件、素材和模型配置全部持久化在 `/opt/toonflow/app`。
自部署页面和业务 API 没有独立登录鉴权；公网入口需要额外认证。
