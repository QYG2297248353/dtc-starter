/**
 * Business-level payment mode. These are not Alipay API names.
 *
 * - `pc`:  desktop page pay (`alipay.trade.page.pay`)
 * - `h5`:  mobile web pay (`alipay.trade.wap.pay`)
 * - `qr`:  pre-create (`alipay.trade.precreate`) rendered as a QR code
 */
export type AlipayMethod = "pc" | "h5" | "qr"

/**
 * Options accepted by the Alipay payment module provider.
 *
 * The provider is registered in `medusa-config.ts` and every option can be
 * supplied through environment variables (see `.env.example`).
 */
export type AlipayOptions = {
  /** Alipay application ID (`app_id`). */
  app_id: string
  /**
   * Application private key used to sign requests. Accepts a PEM string or the
   * bare base64 body (PKCS#1 or PKCS#8). Literal `\n` sequences are expanded.
   */
  private_key: string
  /** Alipay public key used to verify notifications and API responses. */
  alipay_public_key: string
  /** Gateway URL. Defaults to the production gateway. */
  gateway?: string
  /** Async notification URL. Defaults to `<BACKEND_URL>/webhooks/alipay`. */
  notify_url?: string
  /** Browser return URL. Can be overridden per payment session via `data.return_url`. */
  return_url?: string
  /** Optional seller ID checked on incoming notifications. */
  seller_id?: string
  /** Prefix for the Alipay order subject. Defaults to `Order`. */
  subject_prefix?: string
}

/** Subset of the `alipay.trade.query` response used by this provider. */
export type AlipayTrade = {
  out_trade_no?: string
  trade_no?: string
  trade_status?: string
  total_amount?: string
  buyer_id?: string
  send_pay_date?: string
} & Record<string, unknown>

/** Payload posted by Alipay to the asynchronous notification URL. */
export type AlipayNotification = Record<string, string>
