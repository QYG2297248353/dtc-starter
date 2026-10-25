import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// fork-addition: session cookie options driven by environment variables.
// Medusa production mode defaults to Secure+SameSite=None, which breaks
// plain-HTTP deployments. Override per your actual deployment — see
// .env.example or docs/DEPLOYMENT.md for HTTP vs HTTPS recommendations.
const cookieSecure = process.env.COOKIE_SECURE === "true"
const cookieSameSite = (process.env.COOKIE_SAME_SITE || "lax") as "lax" | "strict" | "none"

// Trailing slashes are stripped so BACKEND_URL=.../ and ...://host both work.
const backendUrl = (process.env.BACKEND_URL || "http://localhost:9000").replace(/\/+$/, "")

// fork-addition: Alipay payment provider. It is registered only when the
// application credentials are present, so deployments that do not use Alipay
// keep the stock payment module (Manual / pp_system_default only).
const alipayConfigured = Boolean(
  process.env.ALIPAY_APP_ID &&
    process.env.ALIPAY_PRIVATE_KEY &&
    process.env.ALIPAY_PUBLIC_KEY
)

const alipayProvider = {
  resolve: "./src/modules/payment-alipay",
  // No `id` on purpose: the module exports three providers whose identifiers
  // become pp_alipay_pc, pp_alipay_h5 and pp_alipay_qr. The merchant enables
  // the subsets they need per Region in the Admin.
  options: {
    app_id: process.env.ALIPAY_APP_ID,
    private_key: process.env.ALIPAY_PRIVATE_KEY,
    alipay_public_key: process.env.ALIPAY_PUBLIC_KEY,
    gateway: process.env.ALIPAY_GATEWAY,
    notify_url: process.env.ALIPAY_NOTIFY_URL,
    return_url: process.env.ALIPAY_RETURN_URL,
    seller_id: process.env.ALIPAY_SELLER_ID,
    subject_prefix: process.env.ALIPAY_SUBJECT_PREFIX,
  },
}

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // fork-addition: session cookie security — top-level per Medusa docs
    // (https://docs.medusajs.com/resources/references/medusa-config#cookieoptions)
    cookieOptions: {
      secure: cookieSecure,
      sameSite: cookieSameSite,
    },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  // fork-addition: file module — pin the local provider's public URL so
  // uploaded files get absolute URLs on the real deployment domain.
  modules: [
    // fork-addition: register the Alipay payment provider when configured.
    ...(alipayConfigured
      ? [
          {
            resolve: "@medusajs/medusa/payment",
            options: { providers: [alipayProvider] },
          },
        ]
      : []),
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-local",
            id: "local",
            options: {
              // Public base URL used to build absolute file URLs (product
              // images). The provider has no env fallback in 2.22 — without
              // this option every upload is stored with localhost:9000.
              backend_url: `${backendUrl}/static`,
            },
          },
        ],
      },
    },
  ]
})
