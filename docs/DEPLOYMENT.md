# Medusa 后端部署文档

本文档介绍如何通过 GitHub Actions 构建 Docker 镜像，并用 Docker Compose 部署 **Medusa 后端**（不含 storefront 前端）。PostgreSQL 与 Redis 既可以用 compose 内置的容器，也可以用外部服务——全部通过环境变量配置，无需改代码。

> 本仓库 fork 自 [medusajs/dtc-starter](https://github.com/medusajs/dtc-starter)。为便于后续升级，部署相关文件（`Dockerfile`、`.dockerignore`、`docker-compose.yml`、`docker-compose.external.yml`、`.env.example`、`.github/workflows/docker.yml`、`.github/workflows/sync-fork.yml`、`.github/workflows/ci.yml`）均为**纯新增**；支付宝支付 provider（`apps/backend/src/modules/payment-alipay/`）及其启用脚本也是新增目录/文件。
>
> 改动的上游文件均只做**追加式**修改（`fork-addition` 注释标记）：[apps/backend/medusa-config.ts](../apps/backend/medusa-config.ts)（`cookieOptions`、文件模块 `backend_url`、支付宝 provider 注册）、[initial-data-seed.ts](../apps/backend/src/migration-scripts/initial-data-seed.ts)（新库自动启用支付宝）以及 storefront 的支付选项/按钮/常量。storefront 还新增了 `qrcode.react` 依赖用于展示扫码支付二维码（已同步 `pnpm-lock.yaml`）。上游这些位置变动少，冲突时保留 `fork-addition` 段即可。

## 架构概览

```
┌──────────────────────── GitHub Actions ────────────────────────┐
│ docker.yml    push main / tag v* / 手动触发                      │
│               └─ 多架构构建 (amd64 + arm64)                       │
│               └─ 推送 Docker Hub  +  GHCR                        │
│ sync-fork.yml 每日定时 / 手动触发                                 │
│               └─ 合并上游 medusajs/dtc-starter                   │
│               └─ 冲突时自动开 PR 等待人工处理                      │
└────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
  Docker Hub:                              GHCR:
  qyg2297248353/medusa                     ghcr.io/qyg2297248353/medusa
```

镜像内容：基于 `node:22-alpine`，仅包含 `apps/backend` 经 `medusa build` 编译后的产物与生产依赖。Admin 后台已内置，启动后访问 `http://<host>:9000/app`。

部署提供两种 compose 示例：

| 文件 | 适用场景 |
| --- | --- |
| `docker-compose.yml` | 内置 PostgreSQL 16 + Redis 7 容器，开箱即用 |
| `docker-compose.external.yml` | 完全使用外部 PostgreSQL / Redis（云 RDS、Supabase、ElastiCache 等） |

两者可以混用：在 `docker-compose.yml` 的 `.env` 里直接设置完整 `DATABASE_URL` / `REDIS_URL` 即可覆盖内置服务（见下文）。

## 一、配置 GitHub Secrets（仅构建镜像需要）

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 用途 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名（如 `qyg2297248353`） |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（Account Settings → Security 生成） |
| `GITHUBTOKEN` | GitHub PAT，需 `write:packages`（推送 GHCR）及 `repo` 权限（sync-fork 推送/开 PR）。若未设置，sync-fork 回退使用内置 `GITHUB_TOKEN` |

工作流 [docker.yml](../.github/workflows/docker.yml) 在推送到 `release` 分支、推送 `v*` 标签或手动触发时构建并推送镜像：

| 触发 | 标签示例 |
| --- | --- |
| 推送到 `release` 分支 | `release`, `sha-xxxxxxx` |
| 推送标签 `v1.2.0` | `1.2.0`, `1.2`, `v1.2.0` |
| 推送到默认分支（且该分支为默认分支时） | `latest` |

## 二、部署前置条件

- 一台安装好 Docker（含 compose 插件）的主机：`docker compose version` 能输出版本即可
- 放行端口：默认 `9000`（API + Admin 同端口）
- 若使用外部服务：PostgreSQL 15+、Redis 6+ 的连接信息

## 三、场景 A：内置 PG/Redis（最简部署）

以下命令在部署机上执行。

### 1. 准备部署文件

只需要三个文件（无需克隆整个仓库）：

```bash
mkdir medusa && cd medusa
# 从仓库下载（或 git clone 后复制）
curl -O https://raw.githubusercontent.com/qyg2297248353/dtc-starter/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/qyg2297248353/dtc-starter/main/.env.example
cp .env.example .env
```

### 2. 编辑 .env

```dotenv
# 必填：用强随机值（openssl rand -base64 32 生成）
JWT_SECRET=填我
COOKIE_SECRET=填我

# 内置数据库账号（默认 medusa/medusa/medusa，生产建议改密码）
POSTGRES_USER=medusa
POSTGRES_PASSWORD=改成强密码
POSTGRES_DB=medusa

# 按实际访问域名改（Admin 后台访问地址必须包含在 ADMIN_CORS/AUTH_CORS 中）
STORE_CORS=https://shop.example.com
ADMIN_CORS=https://api.example.com
AUTH_CORS=https://api.example.com

# 后端公网地址（无尾斜杠）。本地文件模块用它拼接上传文件（商品图片等）的绝对 URL。
# 不填则默认 http://localhost:9000，生产环境必须改成实际访问地址，否则图片地址指向 localhost。
BACKEND_URL=https://api.example.com

# Cookie 安全：HTTPS 正式部署必须显式开启 Secure
# （docker-compose 默认 COOKIE_SECURE=false 仅适配 HTTP 测试）
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
```

### 3. 启动

```bash
docker compose pull        # 拉取镜像
docker compose up -d       # 启动
```

启动顺序由 compose 自动控制：`db`/`redis` 健康检查通过 → `migrate` 执行数据库迁移与初始数据后退出 → `backend` 启动并监听 9000。

### 4. 验证

```bash
docker compose ps                          # 各服务状态
docker compose logs -f backend             # 查看后端日志
curl http://localhost:9000/health          # 应返回 OK
```

### 5. 创建管理员账号

```bash
docker compose exec backend ./node_modules/.bin/medusa user -e admin@example.com -p your-password
```

然后访问 `http://<服务器IP>:9000/app` 登录 Admin 后台。

## 四、场景 B：使用外部 PostgreSQL / Redis

### 连接串格式

```dotenv
# PostgreSQL（postgres:// 与 postgresql:// 均可）
DATABASE_URL=postgres://用户名:密码@主机:5432/数据库名

# SSL 行为（重要）：
# Medusa 对非 localhost 的主机【默认启用 SSL】（不校验证书，rejectUnauthorized=false）。
#   - PG 已启用 SSL（云数据库 RDS/Supabase 等）：直接写连接串即可，无需参数
#   - PG 未启用 SSL（自建/docker 默认镜像）：必须追加 ?sslmode=disable（无下划线）
#     否则连接会在 SSL 握手阶段挂起，迁移报 "connection timed out after 10 seconds"
#     注意：Medusa 文档中的 ?ssl_mode=disable（带下划线）会被框架提前剥离，
#     在 2.22 版本下对迁移锁连接不生效，请使用 sslmode=disable。
DATABASE_URL=postgres://user:pass@pg.example.com:5432/medusa?sslmode=disable

# Redis
REDIS_URL=redis://:密码@主机:6379/0
# 无密码：redis://主机:6379
# TLS（如云厂商的 SSL 端点）：
REDIS_URL=rediss://:密码@主机:6380/0
```

注意事项：

- **外部数据库必须提前建好**：`CREATE DATABASE medusa;`。Medusa 只负责迁移表结构，不会创建数据库本身。
- 密码中含 `@`、`#`、`/`、`:` 等特殊字符时需 URL 编码（如 `@` → `%40`）。
- 确保部署机到 PG/Redis 的网络与端口可达（安全组/防火墙）。

### 方式 1（推荐）：使用 docker-compose.external.yml

```bash
curl -O https://raw.githubusercontent.com/qyg2297248353/dtc-starter/main/docker-compose.external.yml
cp .env.example .env
```

编辑 `.env`，填入必填项：

```dotenv
JWT_SECRET=填我
COOKIE_SECRET=填我
DATABASE_URL=postgres://user:pass@pg.example.com:5432/medusa?sslmode=disable
REDIS_URL=redis://:pass@redis.example.com:6379/0
ADMIN_CORS=https://api.example.com
AUTH_CORS=https://api.example.com
STORE_CORS=https://shop.example.com

# 后端公网地址（无尾斜杠）。不填则图片 URL 指向 localhost。
BACKEND_URL=https://api.example.com

# Cookie 安全：HTTPS 正式部署必须显式开启 Secure
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
```

启动（步骤与场景 A 相同，只是多一个 `-f`）：

```bash
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
docker compose -f docker-compose.external.yml logs -f backend
```

### 方式 2：默认 compose 文件 + 覆盖环境变量

`docker-compose.yml` 中的 `DATABASE_URL` / `REDIS_URL` 支持被 `.env` 完整覆盖。在 `.env` 中直接写外部连接串：

```dotenv
DATABASE_URL=postgres://user:pass@pg.example.com:5432/medusa?sslmode=require
REDIS_URL=redis://:pass@redis.example.com:6379/0
```

然后编辑 `docker-compose.yml`：删除（或注释）不再需要的 `db` / `redis` 服务，以及 `migrate`、`backend` 中对它们的 `depends_on` 条目，最后 `docker compose up -d`。

### 混合场景

例如「外部 PG + 内置 Redis」：用 `docker-compose.yml`，`.env` 中只设置外部 `DATABASE_URL`，并删除 `db` 服务及其 `depends_on` 引用即可；Redis 同理。

> 关于 Redis：上游默认配置使用本地 event bus 与内存缓存，`REDIS_URL` 已注入容器备用。后续在 `medusa-config.ts` 中启用 Redis 相关模块（caching / event-bus 等）时可直接读取该变量。暂时不用 Redis 的话，场景 A 中可以删除 `redis` 服务及 `REDIS_URL` 行。

## 五、环境变量说明

| 变量 | 说明 | 必填 | 默认值 |
| --- | --- | --- | --- |
| `JWT_SECRET` | JWT 签名密钥 | 是 | 无 |
| `COOKIE_SECRET` | Cookie 签名密钥 | 是 | 无 |
| `DATABASE_URL` | PostgreSQL 完整连接串 | 外部 PG 时必填 | 由 `POSTGRES_*` 拼出指向内置 db |
| `REDIS_URL` | Redis 完整连接串 | 外部 Redis 时必填 | `redis://redis:6379` |
| `POSTGRES_USER/PASSWORD/DB` | 内置 db 容器的初始化账号 | 否 | `medusa` / `medusa` / `medusa` |
| `STORE_CORS` | Store API 允许来源，逗号分隔 | 否 | `http://localhost:8000` |
| `ADMIN_CORS` | Admin 允许来源 | 否 | `http://localhost:9000` |
| `AUTH_CORS` | 认证端点允许来源 | 否 | `http://localhost:9000` |
| `BACKEND_URL` | 后端公网地址：含协议/主机/端口、无尾斜杠。本地文件模块据此拼接上传文件（商品图片等）的绝对 URL，必须与用户实际访问地址一致 | 否 | `http://localhost:9000` |
| `COOKIE_SECURE` | Session Cookie 是否仅 HTTPS 发送。HTTPS 正式部署设 `true`，HTTP 测试部署设 `false` | 否 | `false` |
| `COOKIE_SAME_SITE` | Session Cookie 的 SameSite 属性（`lax`/`strict`/`none`） | 否 | `lax` |
| `ALIPAY_APP_ID` | 支付宝应用 ID；与私钥、公钥同时非空才会注册支付 provider | 启用支付宝时 | 无 |
| `ALIPAY_PRIVATE_KEY` | 应用私钥，PEM 或单行 + 字面量 `\n` | 启用支付宝时 | 无 |
| `ALIPAY_PUBLIC_KEY` | 支付宝公钥（验签用，不是应用公钥） | 启用支付宝时 | 无 |
| `ALIPAY_GATEWAY` | 支付宝网关。沙箱：`https://openapi-sandbox.dl.alipaydev.com/gateway.do` | 否 | 生产网关 |
| `ALIPAY_NOTIFY_URL` | 异步通知地址，必须公网可达 | 否 | `${BACKEND_URL}/webhooks/alipay` |
| `ALIPAY_RETURN_URL` | 默认同步回跳地址；storefront 会按购物车覆盖 | 否 | 无 |
| `ALIPAY_SELLER_ID` | 配置后校验通知中的 seller_id | 否 | 无 |
| `ALIPAY_SUBJECT_PREFIX` | 支付宝订单标题前缀 | 否 | `Order` |
| `MEDUSA_IMAGE` | 使用的镜像 | 否 | `qyg2297248353/medusa:latest` |
| `PORT` | 宿主机映射端口 | 否 | `9000` |

> 镜像内不含任何 `.env`，所有配置运行时注入，镜像可安全公开分发。请勿把真实 `.env` 提交进仓库（已被 `.gitignore` 与 `.dockerignore` 排除）。中文配置示例见 [.env.cn.example](../.env.cn.example)。

### 支付宝支付（可选）

默认支付方式只有 Manual（`pp_system_default`）。配置 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 后，后端会注册三个独立 Provider：

| Provider ID | 商城显示名称 | 接口 |
| --- | --- | --- |
| `pp_alipay_pc` | Alipay (PC) | `alipay.trade.page.pay` |
| `pp_alipay_h5` | Alipay (H5) | `alipay.trade.wap.pay` |
| `pp_alipay_qr` | Alipay (QR) | `alipay.trade.precreate` |

1. 支付宝开放平台创建应用，按需开通电脑网站支付 / 手机网站支付 / 当面付，异步通知地址填
   `https://<后端域名>/webhooks/alipay`。
2. 在 `.env` 填入三项凭证并 `docker compose up -d`；完整变量、默认值和示例见
   [.env.cn.example](../.env.cn.example)。
3. 启用 Region：

```bash
# 新库：migrate 的 seed 已自动启用三个 Provider
# 存量库：执行一次幂等脚本（生产镜像内是编译后的 .js；会清理旧 pp_alipay_alipay）
docker compose exec backend ./node_modules/.bin/medusa exec ./src/scripts/enable-alipay.js
```

4. 到 Admin → Settings → Regions → 编辑 Region → Payment providers，按实际开通的产品保留
   Alipay (PC) / Alipay (H5) / Alipay (QR) 中的一个或多个。
5. 支付流程：
   - PC/H5：跳转支付宝收银台；回跳 `/api/payment-return/alipay/[cartId]` 完成下单，或由异步通知兜底。
   - QR：后端预下单返回 `qr_code`，storefront 展示二维码并轮询 `/store/alipay/status`。
6. 异步通知走专用路由 `/webhooks/alipay`，验签、app_id/seller_id、金额、币种、payment session 全部通过后才会更新支付；成功返回纯文本 `success`。退款调用 `alipay.trade.refund`，以退款记录的 idempotency key 作为 `out_request_no`；重复调用不会重复退款。

> 本 fork 没有注册 Stripe Provider，只接支付宝时 **不需要** `STRIPE_API_KEY` / `STRIPE_WEBHOOK_SECRET`；填了也不会生效。需要 Stripe 时请另行安装并注册 `@medusajs/medusa/payment-stripe`。

> 详细说明（沙箱、币种、签名校验、密钥格式）见 [.github/README.md](../.github/README.md#支付宝支付可选)。

## 六、升级与回滚

`sync-fork.yml` 每日自动同步上游 `medusajs/dtc-starter`：无冲突则直接合并推送（随后 `docker.yml` 自动构建新镜像），有冲突则自动开 PR 由人工解决。

升级部署机：

```bash
docker compose pull
docker compose up -d      # migrate 服务会先执行新的数据库迁移，backend 再启动
```

回滚：在 `.env` 中把 `MEDUSA_IMAGE` 固定到上一个可用标签（如 `qyg2297248353/medusa:sha-xxxxxxx`），再 `docker compose up -d`。**注意**：数据库迁移通常不可逆，回滚代码前请确认新旧版本 schema 兼容，生产环境升级前建议先备份数据库。

## 七、运维常用命令

```bash
# 日志 / 状态
docker compose logs -f backend
docker compose ps

# 手动重新执行迁移
docker compose run --rm migrate

# 进入容器
docker compose exec backend sh

# 备份内置数据库
docker compose exec db pg_dump -U medusa medusa > backup-$(date +%F).sql

# 备份已上传文件（产品图片等）
docker compose cp backend:/server/static ./static-backup

# 完全重置（危险：删除内置 PG/Redis 数据卷）
docker compose down -v
```

### 上传文件的存储

后端使用 Medusa 默认的**本地文件模块**，上传文件写入容器内 `/server/static`，并由后端在 `/static` 路径对外提供访问。compose 已为该目录挂载命名卷 `medusa_static`，容器重建不会丢图：

- 单实例部署可用；**多副本/多机部署不可用**（各容器本地磁盘不共享），生产建议改用 S3。
- 官方明确本地文件模块仅面向开发环境，生产环境的持久化与备份需自行保障。
- 升级时不要 `docker compose down -v`，否则会一并删除图片卷。

> **从"无卷"旧部署迁移到本版本时**：旧容器的上传文件在容器可写层里，`up -d` 重建容器会丢失。务必先备份再升级：
>
> ```bash
> docker compose cp backend:/server/static ./static-backup   # 1. 先导出
> docker compose up -d                                        # 2. 重建（此时才创建卷）
> docker compose cp ./static-backup/. backend:/server/static  # 3. 回灌到卷
> ```

## 八、常见问题

**Q: 为什么没有构建 storefront？**
本项目仅部署 Medusa 后端 API + Admin 后台。Dockerfile 只安装并构建 `@dtc/backend` 工作区，storefront 不参与构建。

**Q: `migrate` 服务报错退出、backend 不启动？**
先看日志：`docker compose logs migrate`。最常见原因是 `DATABASE_URL` 连不通或外部数据库不存在——Medusa 不自动建库，需先 `CREATE DATABASE`。

**Q: Admin 后台登录失败 / 跨域报错？**
确认访问 Admin 的地址已包含在 `ADMIN_CORS` 与 `AUTH_CORS` 中（含协议与端口），改完 `.env` 后执行 `docker compose up -d` 使配置生效。

**Q: 上传的商品图片保存后显示为 `localhost:9000` 地址、无法加载？**
这是因为后端公网地址 `BACKEND_URL` 未配置，Medusa 本地文件模块默认用 `http://localhost:9000/static` 拼接图片的绝对 URL 并写入数据库。

1. 在 `.env` 中设置 `BACKEND_URL` 为实际访问后端的地址：必须带协议（`http`/`https`）、主机、端口，无尾斜杠，例如 `BACKEND_URL=https://api.example.com`。注意端口：若改了 `PORT`，这里也要写 `:端口`。
2. `docker compose up -d` 重启，**新上传**的图片即使用正确地址。
3. 存量数据需要一次性修正（先备份）：

```bash
docker compose exec -T db psql -U medusa -d medusa <<'SQL'
UPDATE product_image
SET url = replace(url, 'http://localhost:9000/static', 'https://api.example.com/static')
WHERE url LIKE 'http://localhost:9000/static/%';

UPDATE file
SET url = replace(url, 'http://localhost:9000/static', 'https://api.example.com/static')
WHERE url LIKE 'http://localhost:9000/static/%';
SQL
```

把上面的 `https://api.example.com` 换成你的 `BACKEND_URL`。图片文件本身仍在 `/server/static`（见"上传文件的存储"），只是库里记录的地址前缀需要改。生产环境建议改用 S3 等对象存储，而非本地文件模块。

**Q: 登录接口返回成功但始终跳回登录页？**
这是 **Session Cookie 未写入** 的典型症状。Medusa 生产模式（`NODE_ENV=production`）默认给 Cookie 加 `Secure` 标记，浏览器在 `http://IP:9000/app` 这种纯 HTTP 场景下会**静默拒绝写入 Secure Cookie**，表现为登录 `/auth/user` 返回 `200` 但后续请求不带会话 Cookie。

检查 `.env` 中的 `COOKIE_SECURE`：
- **HTTP 测试部署**（直接通过 `http://服务器IP:9000` 访问）：设 `COOKIE_SECURE=false`
- **HTTPS 正式部署**（Nginx/Cloudflare 等反向代理已 TLS 终止）：设 `COOKIE_SECURE=true`

改完后执行 `docker compose up -d` 重启后端，再用无痕窗口重新登录验证。

**Q: GHCR 推送报权限错误？**
确认 `GITHUBTOKEN`（PAT）勾选了 `write:packages` 与 `read:packages`；首次推送后到 GHCR 包页面按需设置可见性。私有镜像部署时需先 `docker login ghcr.io`。

**Q: 只想推送到一个镜像仓库？**
编辑 `.github/workflows/docker.yml`，删除 `metadata-action` 中不需要的 `images` 行及对应的 login 步骤即可。

**Q: 服务器是 ARM 架构（如树莓派/ARM 云主机）？**
工作流已同时构建 `linux/amd64` 与 `linux/arm64`，`docker compose pull` 会自动选择匹配架构。
