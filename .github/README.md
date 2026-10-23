# .github — CI/CD & 部署速览

本仓库 fork 自 `medusajs/dtc-starter`。fork 的唯一目标是：**让 Medusa 后端可以用 Docker Compose 一键部署**（内置或外部 PostgreSQL + Redis），并通过 GitHub Actions 自动构建多架构镜像推送到 Docker Hub 和 GHCR。

fork 新增的所有文件都放在仓库根目录（不改动上游源码），以便 `sync-fork.yml` 每日自动合并上游时最小化冲突。唯一涉及上游源文件的改动是 `apps/backend/medusa-config.ts` 中的 Session Cookie 安全配置（见下文"Cookie 安全修复"）。

---

## 一、fork vs 上游：改了什么

| 上游保持不变 | fork 新增 / 修改 |
| --- | --- |
| `apps/backend/*`（除了 medusa-config.ts） | `Dockerfile` — 多阶段构建，基于 `node:22-alpine`，仅包含 backend 编译产物 |
| `apps/storefront/*`（不参与 Docker 构建） | `.dockerignore` — 排除无关文件，加快构建 |
| 所有上游 workflow | `docker-compose.yml` — 内置 PG 16 + Redis 7 容器，开箱即用 |
| | `docker-compose.external.yml` — 使用外部 PG / Redis |
| | `.env.example` — 部署环境变量模板 |
| | `docs/DEPLOYMENT.md` — 完整部署文档 |
| | `apps/backend/medusa-config.ts` — 加了 `cookieOptions`（env 驱动，见下） |

所有 fork 新增文件均带注释标识，便于后续合并上游时识别。

---

## 二、快速部署（3 步）

```bash
# 1. 准备部署文件（任选其一）
curl -O https://raw.githubusercontent.com/QYG2297248353/dtc-starter/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/QYG2297248353/dtc-starter/main/.env.example
cp .env.example .env

# 2. 编辑 .env —— 必填项：JWT_SECRET、COOKIE_SECRET；其余按实际访问域名调整
#    HTTP 测试部署：COOKIE_SECURE=false  COOKIE_SAME_SITE=lax
#    HTTPS 正式部署：COOKIE_SECURE=true  COOKIE_SAME_SITE=lax

# 3. 启动
docker compose pull
docker compose up -d
```

Admin 后台在 `http://<服务器IP>:9000/app`，首次使用前需要创建管理员：

```bash
docker compose exec backend ./node_modules/.bin/medusa user -e admin@example.com -p your-password
```

完整部署步骤、外部数据库配置、升级回滚、运维命令等见 [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)。

---

## 三、环境变量速查

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `JWT_SECRET` | 是 | — | JWT 签名密钥（`openssl rand -base64 32`） |
| `COOKIE_SECRET` | 是 | — | Cookie 签名密钥 |
| `DATABASE_URL` | 外部 PG 时必填 | 由 `POSTGRES_*` 拼出 | PostgreSQL 完整连接串 |
| `REDIS_URL` | 外部 Redis 时必填 | `redis://redis:6379` | Redis 完整连接串 |
| `ADMIN_CORS` | 否 | `http://localhost:9000` | Admin 允许来源 |
| `AUTH_CORS` | 否 | `http://localhost:9000` | 认证端点允许来源 |
| `STORE_CORS` | 否 | `http://localhost:8000` | Store API 允许来源 |
| `COOKIE_SECURE` | 否 | `false` | Session Cookie 是否仅 HTTPS 发送 |
| `COOKIE_SAME_SITE` | 否 | `lax` | Session Cookie 的 SameSite 属性 |
| `MEDUSA_IMAGE` | 否 | `qyg2297248353/medusa:latest` | 使用的镜像 |
| `PORT` | 否 | `9000` | 宿主机映射端口 |

> HTTPS 正式部署必须把 `COOKIE_SECURE` 设为 `true`，否则浏览器会拒绝写入带 `Secure` 标记的 Cookie（反向代理 TLS 终止场景）。纯 HTTP 测试部署保持默认 `false` 即可。

---

## 四、Session Cookie 安全修复

Medusa 生产模式（`NODE_ENV=production`）默认给 Session Cookie 加 `Secure` + `SameSite=None` 标记。**浏览器在纯 HTTP 场景下会静默拒绝写入 Secure Cookie**，表现为登录接口返回 `200` 但后续所有请求不带会话 Cookie，页面不断跳回登录页。

fork 在 `apps/backend/medusa-config.ts` 中增加了 env 驱动的 `cookieOptions`：

```ts
const cookieSecure = process.env.COOKIE_SECURE === "true"
const cookieSameSite = (process.env.COOKIE_SAME_SITE || "lax") as "lax" | "strict" | "none"

// 在 projectConfig 顶层（与 databaseUrl、http 同级）
cookieOptions: {
  secure: cookieSecure,
  sameSite: cookieSameSite,
},
```

位置：`projectConfig.cookieOptions`，完全符合 [Medusa 官方配置文档](https://docs.medusajs.com/resources/references/medusa-config#cookieoptions)。

---

## 五、GitHub Actions 工作流

### `docker.yml` — 构建并推送 Docker 镜像

| 项目 | 内容 |
| --- | --- |
| **触发条件** | 推送到 `release` 分支、打 `v*` 标签（如 `v1.0.0`）、手动触发 |
| **构建内容** | 多架构（`linux/amd64` + `linux/arm64`），基于 `node:22-alpine`，仅包含 backend 编译产物 |
| **推送目标** | Docker Hub: `qyg2297248353/medusa` · GHCR: `ghcr.io/qyg2297248353/medusa` |
| **标签** | `latest`（release 分支推送）、`sha-xxxxxxx`、语义化版本标签（tag 触发时） |
| **所需 Secrets** | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`、`GITHUBTOKEN`（需 `write:packages` 权限） |

> **注意**：当前工作流配置为触发 `release` 分支，不是 `main`。仓库默认分支是 `main`。推送 `main` 上的提交（如 cookie 修复）后不会自动构建镜像。需要发布镜像时，要么推送到 `release` 分支，要么打 `v*` 标签，要么手动触发 workflow。

### `sync-fork.yml` — 每日同步上游

| 项目 | 内容 |
| --- | --- |
| **触发条件** | 每日 UTC 03:17 定时、手动触发 |
| **做什么** | fetch `medusajs/dtc-starter` → 尝试 fast-forward/merge 到默认分支 → 自动推送 |
| **冲突处理** | 合并失败时推送 `sync/upstream-<run_id>` 分支并自动开 PR，标注冲突需要人工解决 |
| **所需 Secrets** | `GITHUBTOKEN`（需 `contents:write` + `pull-requests:write` 权限）。未设置时回退使用内置 `GITHUB_TOKEN` |

### `update.yaml` — Medusa 版本升级

上游附带的 workflow，通过 `medusajs/medusa-update-action` 自动升级 Medusa 版本并开 PR。需要配置 `ANTHROPIC_API_KEY` secret 才能使用；fork 中未配置。

---

## 六、镜像仓库

| 仓库 | 地址 |
| --- | --- |
| Docker Hub | [qyg2297248353/medusa](https://hub.docker.com/r/qyg2297248353/medusa) |
| GHCR | `ghcr.io/qyg2297248353/medusa` |

部署机上拉取：

```bash
docker pull qyg2297248353/medusa:latest
# 或
docker pull ghcr.io/qyg2297248353/medusa:latest
```

切换镜像仓库：在 `.env` 中设置 `MEDUSA_IMAGE=ghcr.io/qyg2297248353/medusa:latest`。

---

## 七、维护约定

- **优先改 fork 新增文件，不改上游源码**（除非像 Cookie 配置那样确实需要在 `medusa-config.ts` 中加代码）
- 修改上游源码时，务必用 `// fork-addition:` 注释标记，便于后续 sync-fork 时识别和手动解决冲突
- 不要改 `sync-fork.yml`、`update.yaml` 的同步/升级逻辑
- 发布新镜像：创建 `release` 分支（让 sync-fork 自动从 main 合并过去）或打 `v*` 标签，`docker.yml` 会自动构建推送
