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
