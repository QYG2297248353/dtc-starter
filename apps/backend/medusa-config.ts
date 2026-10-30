import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  modules: [
    // Adyen is only registered when it's configured. Enable it in a region, for example from the Medusa Admin.
    ...(process.env.ADYEN_API_KEY
      ? [
          {
            resolve: '@medusajs/medusa/payment',
            options: {
              providers: [
                {
                  resolve: '@medusajs/medusa/payment-adyen',
                  id: 'adyen',
                  options: {
                    apiKey: process.env.ADYEN_API_KEY,
                    merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
                    hmacKey: process.env.ADYEN_HMAC_KEY,
                    environment: process.env.ADYEN_ENVIRONMENT,
                    liveEndpointUrlPrefix: process.env.ADYEN_LIVE_ENDPOINT_URL_PREFIX,
                  },
                },
              ],
            },
          },
        ]
      : []),
  ],
})
