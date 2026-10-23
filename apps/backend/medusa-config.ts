import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// fork-addition: session cookie options driven by environment variables.
// Medusa production mode defaults to Secure+SameSite=None, which breaks
// plain-HTTP deployments. Override per your actual deployment — see
// .env.example or docs/DEPLOYMENT.md for HTTP vs HTTPS recommendations.
const cookieSecure = process.env.COOKIE_SECURE === "true"
const cookieSameSite = (process.env.COOKIE_SAME_SITE || "lax") as "lax" | "strict" | "none"

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
  }
})
