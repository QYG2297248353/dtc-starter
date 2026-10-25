# Medusa DTC Starter — 后端 Docker 部署

本 fork 让 [medusajs/dtc-starter](https://github.com/medusajs/dtc-starter) 的 **Medusa 后端**可以通过 Docker Compose 一键部署到任何 Linux 主机。内置 PostgreSQL 16 + Redis 7，也可以接外部云数据库。

---

## 项目结构

```
.
├── apps/backend/          # Medusa 后端（API + Admin 后台）
│   ├── medusa-config.ts   # fork 追加了 cookieOptions、文件模块 backend_url、支付宝 provider 注册（均 env 驱动）
│   └── src/
│       ├── modules/payment-alipay/   # 支付宝支付 provider（新增）
│       ├── api/webhooks/alipay/      # 异步通知（返回纯文本 success，新增）
│       ├── api/store/alipay/status/  # 扫码支付状态轮询（新增）
│       └── scripts/enable-alipay.ts  # 存量库启用支付宝（新增）
├── apps/storefront/       # Next.js 前端（可选，不参与 Docker 构建）
│   └── src/app/api/payment-return/alipay/  # 支付回跳（新增）
├── Dockerfile             # 多阶段构建，node:22-alpine，仅 backend
├── docker-compose.yml     # 内置 PG + Redis，开箱即用
├── docker-compose.external.yml   # 外部 PG + Redis
├── .env.example           # 部署环境变量模板
├── .env.cn.example        # 同上的中文注解版（推荐新用户使用）
└── docs/DEPLOYMENT.md     # 完整部署文档
```

fork 新增的文件（部署配置、支付宝 provider、通知路由、扫码状态接口、storefront 回跳路由）都独立存放，不改上游既有逻辑。确需在上游文件里追加的少量代码都带 `// fork-addition:` 注释：`medusa-config.ts`（Cookie、文件模块 `backend_url`、支付宝 provider 注册）、`initial-data-seed.ts`（新库自动启用支付宝），以及 storefront 的支付选项/按钮/常量三处。支付宝实现本身全部在新增目录 `apps/backend/src/modules/payment-alipay/` 内。上游每日自动同步，冲突时会自动开 PR 处理。

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

## 支付宝支付（可选）

默认只有 Manual（`pp_system_default`）。填写支付宝应用凭证并重启后，后端会自动注册 **三个独立支付 Provider**；它们彼此独立，商户在 Admin 中按实际开通的产品勾选一个或多个：

| Provider ID | 商城显示名称 | 支付宝接口 | 需要开通的产品 |
| --- | --- | --- | --- |
| `pp_alipay_pc` | Alipay (PC) | `alipay.trade.page.pay` | 电脑网站支付 |
| `pp_alipay_h5` | Alipay (H5) | `alipay.trade.wap.pay` | 手机网站支付 |
| `pp_alipay_qr` | Alipay (QR) | `alipay.trade.precreate` | 当面付（扫码） |

> 用户至少开通一种即可。新库 seed 会把三个都加入默认 Region；存量库执行下面的启用脚本也会三个都加入。之后可在
> **Admin → Settings → Regions → 编辑 Region → Payment providers** 中看到这三个 Provider，并取消不需要的模式。
> 取消后该模式不会出现在商城结账页，但不影响其他两个。
>
> 内置的 Manual（`pp_system_default`）由 Medusa 始终注册，**没有环境变量开关**；新库 seed 默认把它加入 Region，
> 是否需要它在结账页出现，请直接在 Admin 的 Region 支付方式里勾选/取消。

### 1. 支付宝开放平台准备

1. 在[支付宝开放平台](https://open.alipay.com)创建应用。
2. 按需要开通：电脑网站支付、手机网站支付、当面付（扫码）。
3. 使用 RSA2 密钥；应用私钥只保存在后端。
4. 异步通知地址填：`https://<后端域名>/webhooks/alipay`
   （也可以用 `ALIPAY_NOTIFY_URL` 显式指定；必须公网 HTTPS 可达，不能是 localhost）。

### 2. 配置环境变量

可以复制 [.env.cn.example](../.env.cn.example)（中文注解）或 [.env.example](../.env.example)：

```bash
cp .env.cn.example .env
```

最少填写以下三项，支付宝才会启用：

```dotenv
ALIPAY_APP_ID=2021000000000000
# 应用私钥：可整段 PEM，也可单行 + 字面量 \n
ALIPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
# 支付宝公钥（不是应用公钥）
ALIPAY_PUBLIC_KEY=MIIBIjANBg...
```

完整变量说明：

| 变量 | 必填 | 默认值 | 可填写内容 / 示例 |
| --- | --- | --- | --- |
| `ALIPAY_APP_ID` | 启用支付宝时必填 | — | 开放平台应用 APPID，如 `2021000000000000` |
| `ALIPAY_PRIVATE_KEY` | 启用支付宝时必填 | — | 应用私钥。完整 PEM，或单行 + 字面量 `\n`；Node 推荐「非 Java」PKCS#8 |
| `ALIPAY_PUBLIC_KEY` | 启用支付宝时必填 | — | 支付宝公钥（不是应用公钥），用于通知/响应验签 |
| `ALIPAY_GATEWAY` | 否 | 生产网关 `https://openapi.alipay.com/gateway.do` | 沙箱填 `https://openapi-sandbox.dl.alipaydev.com/gateway.do` |
| `ALIPAY_NOTIFY_URL` | 否 | `${BACKEND_URL}/webhooks/alipay` | 公网 HTTPS 地址，如 `https://api.example.com/webhooks/alipay` |
| `ALIPAY_RETURN_URL` | 否 | 空（storefront 按购物车生成） | 自建前端时可填 `https://shop.example.com/order/confirmed` |
| `ALIPAY_SELLER_ID` | 否 | 空（不校验） | 企业支付宝 PID，如 `2088xxxxxxxxxxxx`；填写后会校验通知 |
| `ALIPAY_SUBJECT_PREFIX` | 否 | `Order` | 支付宝订单标题前缀，如 `MyShop Order` |

> 产品码由支付产品固定，不需要配置：PC 为 `FAST_INSTANT_TRADE_PAY`，H5 为 `QUICK_WAP_WAY`，扫码为 `FACE_TO_FACE_PAYMENT`。

### 3. 启用 Region

```bash
# 新库：db:migrate 的初始 seed 已自动启用三个 Alipay Provider
docker compose up -d

# 存量库：执行一次（幂等；会启用 pc/h5/qr，并清理旧的 pp_alipay_alipay）
docker compose exec backend ./node_modules/.bin/medusa exec ./src/scripts/enable-alipay.js
```

然后到 Admin 的 Region 编辑页确认。正常情况下 **Payment providers 会看到 Alipay (PC)、Alipay (H5)、Alipay (QR) 三项**，按需保留。

### 4. 各模式的结账流程

- `Alipay (PC)` / `Alipay (H5)`：storefront 跳转到支付宝收银台；支付完成后由
  `/api/payment-return/alipay/[cartId]` 完成购物车，或由异步通知兜底。
- `Alipay (QR)`：后端调用 `alipay.trade.precreate` 返回 `qr_code`，storefront 渲染二维码并轮询
  `/store/alipay/status`；异步通知到达后自动跳转订单确认页。
- 自定义前端：读取 payment session 的 `data.payment_url`（PC/H5）或 `data.qr_code`（QR）。

### 5. 沙箱

```dotenv
ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do
```

使用沙箱应用的 APPID / 私钥 / 支付宝公钥，并按沙箱买家账号付款。沙箱通常按 **CNY** 测试；如果默认 Region 是 EUR，需要准备 CNY Region 或确认商户支持跨境 EUR。

### 6. 金额、通知与安全

- 金额按 Medusa 货币主单位换算为支付宝 `total_amount`（两位小数）；人民币之外的币种走支付宝跨境收单，需商户号已开通。
- 异步通知必须返回纯文本 `success`。本 fork 使用专用路由 `/webhooks/alipay`，而不是 Medusa 通用
  `/hooks/payment/:provider`，因为后者返回空 200，会让支付宝持续重试。
- 通知会校验 RSA2 签名、`app_id`、可选 `seller_id`、`out_trade_no`（必须是 Medusa payment session ID），
  并要求通知金额/币种与本地 session 完全一致；任一不一致返回 `failure`，不会改动支付状态。
- 退款使用 `alipay.trade.refund`，以退款记录的 idempotency key 作为 `out_request_no`，重复调用不会重复退款。

### 7. 需要 STRIPE_API_KEY 吗？

**只接支付宝时不需要。** 本 fork 没有在 `medusa-config.ts` 中注册 Stripe Provider，所以：

- `STRIPE_API_KEY`、`STRIPE_WEBHOOK_SECRET` 都不需要填写，填了也不会生效。
- Storefront 里的 `NEXT_PUBLIC_STRIPE_KEY` 只对 Stripe 前端组件有意义；没有后端 Stripe Provider 时也用不上。
- 如果你之后确实要接 Stripe，需要另外安装/注册 `@medusajs/medusa/payment-stripe`，再配置 `STRIPE_API_KEY`；生产环境还需要 `STRIPE_WEBHOOK_SECRET` 和 `/hooks/payment/stripe_stripe`。
- 其它未注册的支付 Provider 同理，不需要对应的环境变量。

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
| `ALIPAY_APP_ID` | 启用支付宝时必填 | — | 支付宝应用 ID |
| `ALIPAY_PRIVATE_KEY` | 启用支付宝时必填 | — | 应用私钥（PEM 或单行 `\n`） |
| `ALIPAY_PUBLIC_KEY` | 启用支付宝时必填 | — | 支付宝公钥（验签用） |
| `ALIPAY_GATEWAY` | 否 | 生产网关 | 沙箱网关：`https://openapi-sandbox.dl.alipaydev.com/gateway.do` |
| `ALIPAY_NOTIFY_URL` | 否 | `${BACKEND_URL}/webhooks/alipay` | 异步通知地址，必须公网可达 |
| `ALIPAY_RETURN_URL` | 否 | — | 默认同步回跳地址；storefront 会按购物车覆盖 |
| `ALIPAY_SELLER_ID` | 否 | — | 配置后校验通知中的 seller_id |
| `ALIPAY_SUBJECT_PREFIX` | 否 | `Order` | 支付宝订单标题前缀 |
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
