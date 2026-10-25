import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberInput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"

import {
  AlipayApiError,
  AlipayClient,
  parseNotification,
} from "./client"
import type { AlipayMethod, AlipayOptions, AlipayTrade } from "./types"

type PaymentSessionRecord = {
  id: string
  amount?: unknown
  raw_amount?: unknown
  currency_code?: string
  status?: string
}

type PaymentSessionServiceLike = {
  retrieve(
    id: string,
    config?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<PaymentSessionRecord>
}

type InjectedDependencies = {
  logger: Logger
  paymentSessionService?: PaymentSessionServiceLike
}

const PAID_STATUSES = new Set(["TRADE_SUCCESS", "TRADE_FINISHED"])
const CLOSED_STATUS = "TRADE_CLOSED"
const AMOUNT_EPSILON = 0.005

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function toAmount(amount: BigNumberInput): string {
  const numeric = new BigNumber(amount).numeric

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Alipay amount must be a positive number."
    )
  }

  return numeric.toFixed(2)
}

function toTradeData(trade: AlipayTrade): Record<string, unknown> {
  return {
    trade_no: trade.trade_no,
    trade_status: trade.trade_status,
    total_amount: trade.total_amount,
    buyer_id: trade.buyer_id,
    send_pay_date: trade.send_pay_date,
  }
}

/**
 * Alipay payment provider base class.
 *
 * Three concrete providers share this lifecycle:
 * - `alipay_pc` -> desktop `alipay.trade.page.pay` redirect
 * - `alipay_h5` -> mobile `alipay.trade.wap.pay` redirect
 * - `alipay_qr` -> `alipay.trade.precreate` QR code
 *
 * Each concrete class has its own identifier, so Medusa registers three
 * separate payment providers. Merchants enable one or more per Region in the
 * Admin, and the storefront only shows the enabled ones.
 *
 * Alipay posts an asynchronous notification to `/webhooks/alipay`; the
 * notification is verified against the Alipay public key AND the local
 * payment session (amount/currency) before any Medusa state changes.
 */
abstract class AlipayPaymentProviderBase extends AbstractPaymentProvider<AlipayOptions> {
  protected logger_: Logger
  protected options_: AlipayOptions
  protected client_: AlipayClient
  protected sessionService_?: PaymentSessionServiceLike
  protected readonly method_: AlipayMethod

  constructor(
    container: InjectedDependencies,
    options: AlipayOptions,
    method: AlipayMethod
  ) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.method_ = method
    this.client_ = new AlipayClient(options)
    this.sessionService_ = this.resolveSessionService(container)
  }

  static validateOptions(options: Record<string, unknown>) {
    for (const key of ["app_id", "private_key", "alipay_public_key"]) {
      if (!asString(options[key])) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Alipay provider option "${key}" is required.`
        )
      }
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const sessionId = asString(input.data?.session_id)

    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot initiate an Alipay payment without the Medusa payment session ID."
      )
    }

    const checkoutData = await this.buildCheckoutData({
      sessionId,
      amount: input.amount,
      currencyCode: input.currency_code,
      returnUrl: asString(input.data?.return_url),
    })

    return {
      id: sessionId,
      status: PaymentSessionStatus.PENDING,
      data: { ...input.data, ...checkoutData },
    }
  }

  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const sessionId =
      asString(input.data?.session_id) ?? asString(input.data?.out_trade_no)

    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot update an Alipay payment without the payment session ID."
      )
    }

    const checkoutData = await this.buildCheckoutData({
      sessionId,
      amount: input.amount,
      currencyCode: input.currency_code,
      returnUrl: asString(input.data?.return_url),
    })

    return {
      status: PaymentSessionStatus.PENDING,
      data: { ...input.data, ...checkoutData },
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const trade = await this.queryTrade(input.data)

    if (!trade) {
      return {
        status: PaymentSessionStatus.PENDING_AUTHORIZATION,
        data: input.data ?? {},
      }
    }

    const data = { ...input.data, ...toTradeData(trade) }

    if (PAID_STATUSES.has(trade.trade_status ?? "")) {
      return { status: PaymentSessionStatus.CAPTURED, data }
    }

    if (trade.trade_status === CLOSED_STATUS) {
      return { status: PaymentSessionStatus.CANCELED, data }
    }

    // Page/WAP/QR payments are asynchronous: the customer may not have
    // finished paying yet. Let the cart complete with an awaiting payment
    // status and reconcile later through the webhook or `getPaymentStatus`.
    return { status: PaymentSessionStatus.PENDING_AUTHORIZATION, data }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const trade = await this.queryTrade(input.data)

    if (!trade) {
      return { status: PaymentSessionStatus.PENDING, data: input.data ?? {} }
    }

    const data = { ...input.data, ...toTradeData(trade) }

    if (PAID_STATUSES.has(trade.trade_status ?? "")) {
      return { status: PaymentSessionStatus.CAPTURED, data }
    }

    if (trade.trade_status === CLOSED_STATUS) {
      return { status: PaymentSessionStatus.CANCELED, data }
    }

    return { status: PaymentSessionStatus.PENDING, data }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const trade = await this.queryTrade(input.data)

    if (!trade || !PAID_STATUSES.has(trade.trade_status ?? "")) {
      throw new MedusaError(
        MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
        "Cannot capture an Alipay payment that has not been paid."
      )
    }

    return {
      data: {
        ...input.data,
        ...toTradeData(trade),
        captured_at: new Date().toISOString(),
      },
    }
  }

  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const outTradeNo = this.outTradeNo(input.data)

    if (!outTradeNo) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot refund an Alipay payment without the trade number."
      )
    }

    const outRequestNo =
      asString(input.context?.idempotency_key) ??
      `refund_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

    const refund = await this.client_.refund({
      outTradeNo,
      amount: toAmount(input.amount),
      outRequestNo: outRequestNo.slice(0, 64),
      reason: asString(input.data?.refund_reason),
    })

    let refundQuery: Record<string, unknown> | undefined

    if (refund.fund_change !== "Y") {
      // `fund_change=N` can mean the refund is still processing (or that the
      // same out_request_no was already refunded). Query the final state.
      refundQuery = await this.client_.queryRefund({
        outTradeNo,
        outRequestNo: outRequestNo.slice(0, 64),
      })
    }

    return {
      data: {
        ...input.data,
        last_refund: refund,
        ...(refundQuery ? { last_refund_query: refundQuery } : {}),
      },
    }
  }

  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    return { data: await this.closeTrade(input.data) }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return { data: await this.closeTrade(input.data) }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const trade = await this.queryTrade(input.data)

    return {
      data: trade ? { ...input.data, ...toTradeData(trade) } : input.data ?? {},
    }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const params = parseNotification(payload.rawData ?? payload.data)
    const sessionId = params.out_trade_no

    if (!this.client_.verifyNotification(params)) {
      this.logger_?.warn(
        "Alipay webhook rejected: invalid RSA2 signature."
      )

      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (this.client_.appId && params.app_id !== this.client_.appId) {
      this.logger_?.warn(
        "Alipay webhook rejected: app_id does not match the configured application."
      )

      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (
      this.client_.sellerId &&
      params.seller_id !== this.client_.sellerId
    ) {
      this.logger_?.warn(
        "Alipay webhook rejected: seller_id does not match the configured seller."
      )

      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (!sessionId || !sessionId.startsWith("payses_")) {
      this.logger_?.warn(
        "Alipay webhook ignored: out_trade_no is not a Medusa payment session ID."
      )

      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const amount = Number(params.total_amount)

    if (!Number.isFinite(amount) || amount <= 0) {
      this.logger_?.warn(
        "Alipay webhook ignored: total_amount is missing or invalid."
      )

      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (!(await this.sessionMatchesNotification(sessionId, amount, params))) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const data = { session_id: sessionId, amount: new BigNumber(amount) }

    switch (params.trade_status) {
      case "TRADE_SUCCESS":
      case "TRADE_FINISHED":
        return { action: PaymentActions.SUCCESSFUL, data }
      case "WAIT_BUYER_PAY":
        return { action: PaymentActions.PENDING, data }
      case "TRADE_CLOSED":
        return { action: PaymentActions.CANCELED, data }
      default:
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }

  private resolveSessionService(
    container: InjectedDependencies
  ): PaymentSessionServiceLike | undefined {
    try {
      return container.paymentSessionService
    } catch {
      return undefined
    }
  }

  private async buildCheckoutData(input: {
    sessionId: string
    amount: BigNumberInput
    currencyCode: string
    returnUrl?: string
  }) {
    const currency = (input.currencyCode || "CNY").toUpperCase()
    const amount = toAmount(input.amount)
    const notifyUrl =
      this.options_.notify_url?.trim() || this.defaultNotifyUrl()
    const returnUrl = input.returnUrl || this.options_.return_url
    const subject = `${this.options_.subject_prefix || "Order"} ${input.sessionId}`

    const base = {
      session_id: input.sessionId,
      out_trade_no: input.sessionId,
      method: this.method_,
      ...(returnUrl ? { return_url: returnUrl } : {}),
    }

    if (this.method_ === "qr") {
      const precreate = await this.client_.precreate({
        outTradeNo: input.sessionId,
        amount,
        currency,
        subject,
        notifyUrl,
      })

      if (!precreate.qr_code) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Alipay did not return a qr_code for the pre-created trade."
        )
      }

      return {
        ...base,
        qr_code: precreate.qr_code,
      }
    }

    const redirectMethod = this.method_ === "h5" ? "h5" : "pc"

    return {
      ...base,
      payment_url: this.client_.createRedirectUrl(redirectMethod, {
        outTradeNo: input.sessionId,
        amount,
        currency,
        subject,
        returnUrl,
        notifyUrl,
      }),
    }
  }

  private async sessionMatchesNotification(
    sessionId: string,
    amount: number,
    params: Record<string, string>
  ): Promise<boolean> {
    if (!this.sessionService_) {
      this.logger_?.error(
        "Alipay webhook rejected: payment session service is unavailable, cannot verify the amount."
      )

      return false
    }

    try {
      const session = await this.sessionService_.retrieve(sessionId, {
        select: ["id", "amount", "raw_amount", "currency_code"],
      })
      const expected = new BigNumber(
        (session.raw_amount ?? session.amount ?? 0) as BigNumberInput
      ).numeric

      if (Math.abs(expected - amount) > AMOUNT_EPSILON) {
        this.logger_?.warn(
          `Alipay webhook rejected: amount ${amount} does not match session amount ${expected}.`
        )

        return false
      }

      const expectedCurrency = session.currency_code?.toUpperCase()
      const notifiedCurrency = params.currency?.toUpperCase()

      if (
        expectedCurrency &&
        notifiedCurrency &&
        expectedCurrency !== notifiedCurrency
      ) {
        this.logger_?.warn(
          `Alipay webhook rejected: currency ${notifiedCurrency} does not match session currency ${expectedCurrency}.`
        )

        return false
      }

      return true
    } catch (error) {
      this.logger_?.warn(
        `Alipay webhook rejected: could not load payment session ${sessionId}: ${this.errorMessage(error)}`
      )

      return false
    }
  }

  private defaultNotifyUrl(): string {
    const backendUrl = (process.env.BACKEND_URL || "http://localhost:9000").replace(
      /\/+$/,
      ""
    )

    return `${backendUrl}/webhooks/alipay`
  }

  private outTradeNo(data?: Record<string, unknown>): string | undefined {
    return asString(data?.out_trade_no) ?? asString(data?.session_id)
  }

  private async queryTrade(
    data?: Record<string, unknown>
  ): Promise<AlipayTrade | null> {
    const outTradeNo = this.outTradeNo(data)

    if (!outTradeNo) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot query an Alipay trade without the trade number."
      )
    }

    try {
      return await this.client_.queryTrade(outTradeNo)
    } catch (error) {
      throw this.buildError("Failed to query the Alipay trade", error)
    }
  }

  private async closeTrade(
    data?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const outTradeNo = this.outTradeNo(data)

    if (!outTradeNo) {
      return data ?? {}
    }

    try {
      await this.client_.closeTrade(outTradeNo)
    } catch (error) {
      // Alipay refuses to close a paid trade. Medusa can still cancel the
      // order locally; a captured payment must be refunded instead.
      this.logger_?.warn(
        `Could not close Alipay trade ${outTradeNo}: ${this.errorMessage(error)}`
      )
    }

    return data ?? {}
  }

  private buildError(message: string, error: unknown): Error {
    if (error instanceof MedusaError) {
      return error
    }

    if (error instanceof AlipayApiError) {
      return new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `${message}: ${error.message}`
      )
    }

    return new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `${message}: ${this.errorMessage(error)}`
    )
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

class AlipayPcPaymentProviderService extends AlipayPaymentProviderBase {
  static identifier = "alipay_pc"

  constructor(container: InjectedDependencies, options: AlipayOptions) {
    super(container, options, "pc")
  }
}

class AlipayH5PaymentProviderService extends AlipayPaymentProviderBase {
  static identifier = "alipay_h5"

  constructor(container: InjectedDependencies, options: AlipayOptions) {
    super(container, options, "h5")
  }
}

class AlipayQrPaymentProviderService extends AlipayPaymentProviderBase {
  static identifier = "alipay_qr"

  constructor(container: InjectedDependencies, options: AlipayOptions) {
    super(container, options, "qr")
  }
}

export {
  AlipayH5PaymentProviderService,
  AlipayPcPaymentProviderService,
  AlipayQrPaymentProviderService,
}

