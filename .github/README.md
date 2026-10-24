# Medusa DTC Starter — 后端 Docker 部署

本 fork 让 [medusajs/dtc-starter](https://github.com/medusajs/dtc-starter) 的 **Medusa 后端**可以通过 Docker Compose 一键部署到任何 Linux 主机。内置 PostgreSQL 16 + Redis 7，也可以接外部云数据库。

---

## 项目结构

```
.
├── apps/backend/          # Medusa 后端（API + Admin 后台）
│   └── medusa-config.ts   # fork 追加了 cookieOptions 与文件模块 backend_url（均 env 驱动）
├── apps/storefront/       # Next.js 前端（可选，不参与 Docker 构建）
├── Dockerfile             # 多阶段构建，node:22-alpine，仅 backend
├── docker-compose.yml     # 内置 PG + Redis，开箱即用
├── docker-compose.external.yml   # 外部 PG + Redis
├── .env.example           # 部署环境变量模板
└── docs/DEPLOYMENT.md     # 完整部署文档
```

fork 新增的所有文件都放在仓库根目录，不改上游源码。仅有的例外（用 `// fork-addition:` 注释标记）：`medusa-config.ts` 里的 Cookie 配置与本地文件模块的 `backend_url`——后者没有环境变量兜底，不配会把上传图片的 URL 写成 `localhost:9000`。上游每日自动同步，冲突时会自动开 PR 处理。

---

## 3 步部署

```bash
# 1. 准备文件
mkdir medusa && cd medusa
curl -O https://raw.githubusercontent.com/QYG2297248353/dtc-starter/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/QYG2297248353/dtc-starter/main/.env.example
cp .env.example .env

# 2. 编辑 .env（必填：JWT_SECRET、COOKIE_SECRET；按实际访问地址改 CORS 与 BACKEND_URL）

# 3. 启动
docker compose pull
docker compose up -d
```

Admin 后台：`http://<服务器IP>:9000/app`

创建管理员账号：

```bash
docker compose exec backend ./node_modules/.bin/medusa user -e admin@example.com -p your-password
```

---

## 外部数据库

使用外部 PostgreSQL / Redis（云 RDS、Supabase、ElastiCache 等）时，用另一个 compose 文件：

```bash
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
```

`.env` 里填 `DATABASE_URL` 和 `REDIS_URL` 即可。**外部数据库必须提前建好**——Medusa 只迁移表结构，不创建数据库本身。

---

## 上传文件（商品图片）

后端用 Medusa 默认的本地文件模块，上传的文件存放在容器内 `/server/static`。compose 已为该目录挂载命名卷 `medusa_static`，容器重建不会丢图；`docker compose down -v` 会连图片一起删除。

- 仅适用**单实例**部署；多副本/多机需改用 S3（本地文件模块官方定位为开发用途）。
- 图片地址由 `BACKEND_URL` 决定，**部署到非 localhost 地址时必须设置**，否则会写成 `http://localhost:9000/static/...`。

---

## 环境变量速查

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `JWT_SECRET` | 是 | — | JWT 签名密钥（`openssl rand -base64 32`） |
| `COOKIE_SECRET` | 是 | — | Cookie 签名密钥 |
| `DATABASE_URL` | 外部 PG 时必填 | 由 `POSTGRES_*` 拼出 | PostgreSQL 完整连接串 |
| `REDIS_URL` | 外部 Redis 时必填 | `redis://redis:6379` | Redis 完整连接串 |
| `ADMIN_CORS` | 否 | `http://localhost:9000` | Admin 允许来源 |
| `AUTH_CORS` | 否 | `http://localhost:9000` | 认证端点允许来源 |
| `STORE_CORS` | 否 | `http://localhost:8000` | Store API 允许来源 |
| `BACKEND_URL` | 非 localhost 部署时必填 | `http://localhost:9000` | 后端公网地址：含协议/主机/端口、无尾斜杠。决定上传图片等文件的绝对 URL |
| `COOKIE_SECURE` | 否 | `false` | Session Cookie 是否仅 HTTPS 发送 |
| `COOKIE_SAME_SITE` | 否 | `lax` | Session Cookie 的 SameSite 属性 |
| `MEDUSA_IMAGE` | 否 | `qyg2297248353/medusa:latest` | 使用的镜像 |
| `PORT` | 否 | `9000` | 宿主机映射端口 |

---

## Cookie 安全配置

Medusa 生产模式（`NODE_ENV=production`）默认给 Session Cookie 加 `Secure` + `SameSite=None`。浏览器在纯 HTTP 下会**静默拒绝写入 Secure Cookie**，表现为登录接口返回 200 但始终跳回登录页。

`.env` 里按你的部署场景选：

| 场景 | `COOKIE_SECURE` | `COOKIE_SAME_SITE` |
| --- | --- | --- |
| HTTP 测试（`http://服务器IP:9000`） | `false` | `lax` |
| HTTPS 正式（反向代理 TLS 终止） | `true` | `lax` |

改完 `.env` 执行 `docker compose up -d` 让配置生效。

---

## 常见问题

**登录接口返回成功但始终跳回登录页？** → 检查 `COOKIE_SECURE` 是否与你的访问协议匹配。HTTP 部署设 `false`，HTTPS 设 `true`。

**`migrate` 服务失败、backend 不启动？** → 先跑 `docker compose logs migrate`。最常见原因：外部数据库不存在（需要先 `CREATE DATABASE medusa;`），或者 `DATABASE_URL` 没加 `?sslmode=disable`（自建 PG 默认不启 SSL）。

**登录失败 / 跨域报错？** → 确认实际访问 Admin 的地址（含协议和端口）已包含在 `ADMIN_CORS` 和 `AUTH_CORS` 中。

**上传的图片保存后不显示、地址是 `localhost:9000`？** → 设置 `BACKEND_URL` 为实际访问地址后重启，新上传的图片即正常；存量数据需按 [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) 里的 SQL 批量替换地址前缀。

**升级怎么做？** → `docker compose pull && docker compose up -d`，`migrate` 会自动执行新的数据库迁移。图片卷 `medusa_static` 不受影响；若从**没有挂载该卷的旧版本**升级，先 `docker compose cp backend:/server/static ./static-backup` 备份，升级后再回灌（步骤见部署文档）。

---

镜像仓库：
- Docker Hub: [`qyg2297248353/medusa`](https://hub.docker.com/r/qyg2297248353/medusa)
- GHCR: `ghcr.io/qyg2297248353/medusa`

详细部署步骤、连接串格式、运维命令、回滚方案等见 [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)。
