import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  KeyObject,
} from "node:crypto"

import type { AlipayNotification, AlipayOptions, AlipayTrade } from "./types"

const DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_SUBJECT_LENGTH = 256

// Alipay fixes the product code per payment product:
// PC = FAST_INSTANT_TRADE_PAY, H5 = QUICK_WAP_WAY, QR = FACE_TO_FACE_PAYMENT.
const PC_PRODUCT_CODE = "FAST_INSTANT_TRADE_PAY"
const H5_PRODUCT_CODE = "QUICK_WAP_WAY"
const QR_PRODUCT_CODE = "FACE_TO_FACE_PAYMENT"

const SIGN_TYPE = "RSA2"
const SIGN_ALGORITHM = "RSA-SHA256"
const LEGACY_SIGN_ALGORITHM = "RSA-SHA1"

type AlipayApiPayload = {
  code?: string
  msg?: string
  sub_code?: string
  sub_msg?: string
} & Record<string, unknown>

export class AlipayApiError extends Error {
  readonly code?: string
  readonly subCode?: string

  constructor(message: string, code?: string, subCode?: string) {
    super(message)
    this.name = "AlipayApiError"
    this.code = code
    this.subCode = subCode
  }
}

const isTradeMissing = (error: unknown) =>
  error instanceof AlipayApiError &&
  (error.subCode === "ACQ.TRADE_NOT_EXIST" ||
    error.subCode === "ACQ.TRADE_NOT_EXISTS")

const isTradeClosed = (error: unknown) =>
  error instanceof AlipayApiError &&
  (isTradeMissing(error) || error.subCode === "ACQ.TRADE_STATUS_ERROR")

/**
 * Expand a bare base64 key body into a PEM document. Alipay's key tool emits
 * keys without the PEM header/footer, and users sometimes paste values with
 * literal `\n` sequences when configuring environment variables.
 */
function toPem(value: string, label: "PRIVATE KEY" | "RSA PRIVATE KEY" | "PUBLIC KEY") {
  const normalized = value.trim().replace(/\\n/g, "\n")

  if (normalized.includes("-----BEGIN")) {
    return normalized
  }

  const body = normalized.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? ""

  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}

function createPrivateKeyFromConfig(value: string): KeyObject {
  const pem = toPem(value, "PRIVATE KEY")

  try {
    return createPrivateKey(pem)
  } catch {
    // Alipay's Java key tool emits PKCS#1 keys ("RSA PRIVATE KEY").
    return createPrivateKey(toPem(value, "RSA PRIVATE KEY"))
  }
}

function createPublicKeyFromConfig(value: string): KeyObject {
  return createPublicKey(toPem(value, "PUBLIC KEY"))
}

function alipayTimestamp(date = new Date()): string {
  // Alipay expects Beijing time (UTC+8) in `yyyy-MM-dd HH:mm:ss` format.
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000)

  return chinaTime.toISOString().slice(0, 19).replace("T", " ")
}

function signContent(params: Record<string, string | undefined>): string {
  return Object.keys(params)
    .filter(
      (key) =>
        key !== "sign" && params[key] !== undefined && params[key] !== ""
    )
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&")
}

function toNotificationRecord(
  value: Record<string, unknown>
): AlipayNotification {
  const params: AlipayNotification = {}

  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) {
      continue
    }

    params[key] = Array.isArray(raw) ? String(raw[0]) : String(raw)
  }

  return params
}

/**
 * Normalize the body of an Alipay asynchronous notification. The Medusa
 * webhook route provides both the parsed body and the raw body; the raw body
 * is preferred so values are decoded exactly once.
 */
export function parseNotification(
  rawData: string | Buffer | Record<string, unknown> | undefined
): AlipayNotification {
  if (rawData === undefined || rawData === null) {
    return {}
  }

  if (typeof rawData === "string" || Buffer.isBuffer(rawData)) {
    const text = rawData.toString().trim()

    if (!text) {
      return {}
    }

    if (text.startsWith("{")) {
      try {
        return toNotificationRecord(JSON.parse(text))
      } catch {
        return {}
      }
    }

    return toNotificationRecord(
      Object.fromEntries(new URLSearchParams(text).entries())
    )
  }

  return toNotificationRecord(rawData)
}

/**
 * Small, dependency-free Alipay OpenAPI 2.0 client. Only the endpoints needed
 * by the provider are implemented: page pay, trade query, refund and close.
 */
export class AlipayClient {
  readonly appId: string
  readonly sellerId?: string

  private readonly gateway: string
  private readonly notifyUrl?: string
  private readonly returnUrl?: string
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  private readonly fetchImpl: typeof fetch

  constructor(options: AlipayOptions) {
    this.appId = options.app_id
    this.sellerId = options.seller_id
    this.gateway = options.gateway?.trim() || DEFAULT_GATEWAY
    this.notifyUrl = options.notify_url?.trim() || undefined
    this.returnUrl = options.return_url?.trim() || undefined
    this.privateKey = createPrivateKeyFromConfig(options.private_key)
    this.publicKey = createPublicKeyFromConfig(options.alipay_public_key)
    this.fetchImpl = (input, init) => globalThis.fetch(input, init)
  }

  /**
   * Backwards-compatible alias for the desktop redirect flow.
   */
  createPagePayUrl(input: {
    outTradeNo: string
    amount: string
    currency: string
    subject: string
    returnUrl?: string
    notifyUrl?: string
  }): string {
    return this.createRedirectUrl("pc", input)
  }

  /**
   * Build a signed URL for a redirect-based Alipay payment.
   *
   * - `pc`  uses `alipay.trade.page.pay` / `FAST_INSTANT_TRADE_PAY`
   * - `h5`  uses `alipay.trade.wap.pay` / `QUICK_WAP_WAY`
   */
  createRedirectUrl(
    method: "pc" | "h5",
    input: {
      outTradeNo: string
      amount: string
      currency: string
      subject: string
      returnUrl?: string
      notifyUrl?: string
    }
  ): string {
    const isWap = method === "h5"
    const bizContent: Record<string, string> = {
      out_trade_no: input.outTradeNo,
      product_code: isWap ? H5_PRODUCT_CODE : PC_PRODUCT_CODE,
      total_amount: input.amount,
      subject: input.subject.slice(0, MAX_SUBJECT_LENGTH),
    }

    if (input.currency && input.currency.toUpperCase() !== "CNY") {
      bizContent.currency = input.currency.toUpperCase()
    }

    const params: Record<string, string> = {
      app_id: this.appId,
      method: isWap ? "alipay.trade.wap.pay" : "alipay.trade.page.pay",
      format: "JSON",
      charset: "utf-8",
      sign_type: SIGN_TYPE,
      timestamp: alipayTimestamp(),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
    }

    const returnUrl = input.returnUrl?.trim() || this.returnUrl
    const notifyUrl = input.notifyUrl?.trim() || this.notifyUrl

    if (returnUrl) {
      params.return_url = returnUrl
    }

    if (notifyUrl) {
      params.notify_url = notifyUrl
    }

    const signed = this.sign(params)
    const query = Object.keys(signed)
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(signed[key])}`
      )
      .join("&")

    return `${this.gateway}${this.gateway.includes("?") ? "&" : "?"}${query}`
  }

  /**
   * Create a face-to-face trade and return its `qr_code`. Creating the QR code
   * only means the trade is waiting for payment; it is not proof of payment.
   */
  async precreate(input: {
    outTradeNo: string
    amount: string
    currency: string
    subject: string
    notifyUrl?: string
  }): Promise<{ qr_code: string; out_trade_no?: string }> {
    const bizContent: Record<string, string> = {
      out_trade_no: input.outTradeNo,
      product_code: QR_PRODUCT_CODE,
      total_amount: input.amount,
      subject: input.subject.slice(0, MAX_SUBJECT_LENGTH),
    }

    if (input.currency && input.currency.toUpperCase() !== "CNY") {
      bizContent.currency = input.currency.toUpperCase()
    }

    const notifyUrl = input.notifyUrl?.trim() || this.notifyUrl

    return await this.request(
      "alipay.trade.precreate",
      bizContent,
      notifyUrl ? { notify_url: notifyUrl } : {}
    )
  }

  /** Query the final state of a refund request. */
  async queryRefund(input: {
    outTradeNo: string
    outRequestNo: string
  }): Promise<Record<string, unknown>> {
    return await this.request("alipay.trade.fastpay.refund.query", {
      out_trade_no: input.outTradeNo,
      out_request_no: input.outRequestNo,
    })
  }

  /** Query a trade by the merchant order number (`out_trade_no`). */
  async queryTrade(outTradeNo: string): Promise<AlipayTrade | null> {
    try {
      return await this.request<AlipayTrade>("alipay.trade.query", {
        out_trade_no: outTradeNo,
      })
    } catch (error) {
      if (isTradeMissing(error)) {
        return null
      }

      throw error
    }
  }

  /** Refund a captured trade. `outRequestNo` makes the call idempotent. */
  async refund(input: {
    outTradeNo: string
    amount: string
    outRequestNo: string
    reason?: string
  }): Promise<Record<string, unknown>> {
    return await this.request("alipay.trade.refund", {
      out_trade_no: input.outTradeNo,
      refund_amount: input.amount,
      out_request_no: input.outRequestNo,
      ...(input.reason ? { refund_reason: input.reason } : {}),
    })
  }

  /** Close an unpaid trade. Alipay rejects closing a paid trade. */
  async closeTrade(outTradeNo: string): Promise<void> {
    try {
      await this.request("alipay.trade.close", { out_trade_no: outTradeNo })
    } catch (error) {
      if (isTradeClosed(error)) {
        return
      }

      throw error
    }
  }

  /**
   * Verify the RSA2 signature of an asynchronous notification. Alipay signs the
   * parameters sorted by key, excluding `sign`. Some integrations include
   * `sign_type` in the signed content and some do not, so both variants are
   * accepted (the official SDK behaves the same way).
   */
  verifyNotification(params: AlipayNotification): boolean {
    const signature = params.sign

    if (!signature) {
      return false
    }

    const signType = params.sign_type || SIGN_TYPE
    const algorithm =
      signType.toUpperCase() === "RSA" ? LEGACY_SIGN_ALGORITHM : SIGN_ALGORITHM
    const withSignType: Record<string, string> = { ...params, sign_type: signType }
    delete withSignType.sign

    if (this.verify(signContent(withSignType), signature, algorithm)) {
      return true
    }

    delete withSignType.sign_type

    return this.verify(signContent(withSignType), signature, algorithm)
  }

  private sign(params: Record<string, string | undefined>): Record<string, string> {
    const content = signContent(params)
    const signature = createSign(SIGN_ALGORITHM)
      .update(content, "utf8")
      .sign(this.privateKey, "base64")

    const signed: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        signed[key] = value
      }
    }
    signed.sign = signature

    return signed
  }

  private verify(
    content: string,
    signature: string,
    algorithm = SIGN_ALGORITHM
  ): boolean {
    try {
      const verifier = createVerify(algorithm)
      verifier.update(content, "utf8")

      return verifier.verify(
        this.publicKey,
        Buffer.from(signature, "base64")
      )
    } catch {
      return false
    }
  }

  /**
   * Extract the signed fragment from an OpenAPI response. Alipay signs the JSON
   * object between the response key and the trailing `"sign"` property.
   */
  private extractResponseSignContent(raw: string, responseKey: string): string {
    const start = raw.indexOf(`"${responseKey}"`)
    const end = raw.lastIndexOf('"sign"')

    if (start < 0 || end < 0 || end <= start) {
      return ""
    }

    let content = raw.substring(start + responseKey.length + 2, end)
    content = content.replace(/^[^{]*{/, "{")
    content = content.replace(/\}([^}]*)$/, "}")

    return content
  }

  private async request<T>(
    method: string,
    bizContent: Record<string, unknown>,
    extraParams: Record<string, string> = {}
  ): Promise<T & AlipayApiPayload> {
    const params: Record<string, string> = {
      app_id: this.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: SIGN_TYPE,
      timestamp: alipayTimestamp(),
      version: "1.0",
      ...extraParams,
      biz_content: JSON.stringify(bizContent),
    }

    const signed = this.sign(params)
    const response = await this.fetchImpl(this.gateway, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        accept: "application/json",
      },
      body: new URLSearchParams(signed).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const raw = await response.text()

    if (!response.ok) {
      throw new AlipayApiError(
        `Alipay request ${method} failed with HTTP ${response.status}`
      )
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw)
    } catch {
      throw new AlipayApiError(`Alipay returned an invalid JSON response`)
    }

    const methodKey = `${method.replace(/\./g, "_")}_response`
    const responseKey = body[methodKey] ? methodKey : "error_response"
    const payload = body[responseKey] as AlipayApiPayload | undefined

    if (!payload) {
      throw new AlipayApiError(
        `Alipay response does not contain ${methodKey}`
      )
    }

    const signature = body.sign
    if (typeof signature === "string" && signature) {
      const content = this.extractResponseSignContent(raw, responseKey)
      if (!content || !this.verify(content, signature)) {
        throw new AlipayApiError(
          `Alipay response signature verification failed for ${method}`
        )
      }
    }

    if (payload.code && payload.code !== "10000") {
      throw new AlipayApiError(
        payload.sub_msg || payload.msg || `Alipay request ${method} failed`,
        payload.code,
        payload.sub_code
      )
    }

    return payload as T & AlipayApiPayload
  }
}
