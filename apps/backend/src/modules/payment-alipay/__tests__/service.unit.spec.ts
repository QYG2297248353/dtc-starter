import { createSign, generateKeyPairSync } from "node:crypto"

import {
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"

import {
  AlipayH5PaymentProviderService,
  AlipayPcPaymentProviderService,
  AlipayQrPaymentProviderService,
} from "../service"
import type { AlipayNotification, AlipayOptions } from "../types"

type ProviderMode = "pc" | "h5" | "qr"
type ProviderInstance = InstanceType<typeof AlipayPcPaymentProviderService>

const PROVIDERS = {
  pc: AlipayPcPaymentProviderService,
  h5: AlipayH5PaymentProviderService,
  qr: AlipayQrPaymentProviderService,
} as const

type KeyPair = {
  privatePem: string
  publicPem: string
}

type FakeClient = {
  appId: string
  sellerId?: string
  createRedirectUrl: jest.Mock
  precreate: jest.Mock
  queryTrade: jest.Mock
  queryRefund: jest.Mock
  refund: jest.Mock
  closeTrade: jest.Mock
  verifyNotification: jest.Mock
}

type FakeSessionService = {
  retrieve: jest.Mock
}

function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })

  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
}

function signNotification(
  params: Record<string, string>,
  privatePem: string
): string {
  const content = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&")

  return createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(privatePem, "base64")
}

function createProvider(
  options: AlipayOptions,
  mode: ProviderMode = "pc",
  session: { amount?: number; currency_code?: string; amountRaw?: string } = {}
) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger

  const paymentSessionService: FakeSessionService = {
    retrieve: jest.fn(async () => ({
      id: "payses_123",
      amount: session.amount ?? 10.5,
      raw_amount: {
        value: session.amountRaw ?? String(session.amount ?? 10.5),
        precision: 20,
      },
      currency_code: session.currency_code ?? "usd",
    })),
  }

  const Provider = PROVIDERS[mode]
  const provider = new Provider(
    { logger, paymentSessionService } as unknown as ConstructorParameters<
      typeof AlipayPcPaymentProviderService
    >[0],
    options
  )

  return { provider, logger, paymentSessionService }
}

function installFakeClient(
  provider: ProviderInstance,
  overrides: Partial<FakeClient> = {}
) {
  const client: FakeClient = {
    appId: "2021000000000000",
    createRedirectUrl: jest.fn(
      () => "https://openapi.alipay.com/gateway.do?signed=1"
    ),
    precreate: jest.fn(async () => ({
      qr_code: "https://qr.alipay.com/sandbox-qr-1",
      out_trade_no: "payses_123",
    })),
    queryTrade: jest.fn(),
    queryRefund: jest.fn(),
    refund: jest.fn(),
    closeTrade: jest.fn(),
    verifyNotification: jest.fn(() => true),
    ...overrides,
  }

  const target = provider as unknown as { client_: FakeClient }
  target.client_ = client

  return client
}

const appKeys = generateKeyPair()
const alipayKeys = generateKeyPair()

const options: AlipayOptions = {
  app_id: "2021000000000000",
  private_key: appKeys.privatePem,
  alipay_public_key: alipayKeys.publicPem,
  notify_url: "https://api.example.com/webhooks/alipay",
}

const sessionData = {
  session_id: "payses_123",
  return_url: "https://shop.example.com/api/payment-return/alipay",
}

describe("Alipay payment providers", () => {
  it("validates required options", () => {
    expect(() =>
      AlipayPcPaymentProviderService.validateOptions({
        app_id: "app",
        private_key: "key",
        alipay_public_key: "public",
      })
    ).not.toThrow()

    expect(() =>
      AlipayPcPaymentProviderService.validateOptions({ app_id: "app" })
    ).toThrow(MedusaError)
  })

  it("exposes one provider identifier per payment mode", () => {
    expect(AlipayPcPaymentProviderService.identifier).toBe("alipay_pc")
    expect(AlipayH5PaymentProviderService.identifier).toBe("alipay_h5")
    expect(AlipayQrPaymentProviderService.identifier).toBe("alipay_qr")
  })

  it("initiates a payment session with a signed cashier URL", async () => {
    const { provider } = createProvider(options)
    const client = installFakeClient(provider)

    const result = await provider.initiatePayment({
      amount: 10.5,
      currency_code: "eur",
      data: sessionData,
    })

    expect(result.status).toBe(PaymentSessionStatus.PENDING)
    expect(result.id).toBe("payses_123")
    expect(result.data).toMatchObject({
      session_id: "payses_123",
      out_trade_no: "payses_123",
      method: "pc",
      payment_url: "https://openapi.alipay.com/gateway.do?signed=1",
      return_url: sessionData.return_url,
    })
    expect(client.createRedirectUrl).toHaveBeenCalledWith(
      "pc",
      expect.objectContaining({
        outTradeNo: "payses_123",
        amount: "10.50",
        currency: "EUR",
        returnUrl: sessionData.return_url,
        notifyUrl: options.notify_url,
      })
    )
  })

  it("uses the H5 gateway for the H5 provider", async () => {
    const { provider } = createProvider(options, "h5")
    const client = installFakeClient(provider)

    const result = await provider.initiatePayment({
      amount: 10.5,
      currency_code: "cny",
      data: sessionData,
    })

    expect(result.data).toMatchObject({ method: "h5" })
    expect(client.createRedirectUrl).toHaveBeenCalledWith(
      "h5",
      expect.objectContaining({ outTradeNo: "payses_123", currency: "CNY" })
    )
    expect(client.precreate).not.toHaveBeenCalled()
  })

  it("creates a QR code for the QR provider", async () => {
    const { provider } = createProvider(options, "qr")
    const client = installFakeClient(provider)

    const result = await provider.initiatePayment({
      amount: 10.5,
      currency_code: "cny",
      data: sessionData,
    })

    expect(result.data).toMatchObject({
      method: "qr",
      qr_code: "https://qr.alipay.com/sandbox-qr-1",
    })
    expect(result.data).not.toHaveProperty("payment_url")
    expect(client.precreate).toHaveBeenCalledWith(
      expect.objectContaining({
        outTradeNo: "payses_123",
        amount: "10.50",
        currency: "CNY",
        notifyUrl: options.notify_url,
      })
    )
  })

  it("rejects initiation without a Medusa session ID", async () => {
    const { provider } = createProvider(options)
    installFakeClient(provider)

    await expect(
      provider.initiatePayment({ amount: 10, currency_code: "eur" })
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("maps paid, pending and closed trades to payment statuses", async () => {
    const { provider } = createProvider(options)
    const client = installFakeClient(provider)

    client.queryTrade.mockResolvedValueOnce({
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
      trade_no: "2026102522001",
      total_amount: "10.50",
    })
    await expect(
      provider.authorizePayment({ data: sessionData })
    ).resolves.toMatchObject({
      status: PaymentSessionStatus.CAPTURED,
      data: expect.objectContaining({ trade_no: "2026102522001" }),
    })

    client.queryTrade.mockResolvedValueOnce({
      out_trade_no: "payses_123",
      trade_status: "WAIT_BUYER_PAY",
    })
    await expect(
      provider.authorizePayment({ data: sessionData })
    ).resolves.toMatchObject({
      status: PaymentSessionStatus.PENDING_AUTHORIZATION,
    })

    client.queryTrade.mockResolvedValueOnce({
      out_trade_no: "payses_123",
      trade_status: "TRADE_CLOSED",
    })
    await expect(
      provider.authorizePayment({ data: sessionData })
    ).resolves.toMatchObject({ status: PaymentSessionStatus.CANCELED })

    client.queryTrade.mockResolvedValueOnce(null)
    await expect(
      provider.authorizePayment({ data: sessionData })
    ).resolves.toMatchObject({
      status: PaymentSessionStatus.PENDING_AUTHORIZATION,
    })
  })

  it("captures only paid trades", async () => {
    const { provider } = createProvider(options)
    const client = installFakeClient(provider)

    client.queryTrade.mockResolvedValueOnce({
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
    })

    const captured = await provider.capturePayment({ data: sessionData })
    expect(captured.data).toMatchObject({
      trade_status: "TRADE_SUCCESS",
      captured_at: expect.any(String),
    })

    client.queryTrade.mockResolvedValueOnce({
      out_trade_no: "payses_123",
      trade_status: "WAIT_BUYER_PAY",
    })
    await expect(
      provider.capturePayment({ data: sessionData })
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("refunds the requested amount with the idempotency key", async () => {
    const { provider } = createProvider(options)
    const client = installFakeClient(provider)
    client.refund.mockResolvedValue({ refund_fee: "12.34", fund_change: "Y" })

    const result = await provider.refundPayment({
      amount: 12.34,
      data: sessionData,
      context: { idempotency_key: "refund_123" },
    })

    expect(client.refund).toHaveBeenCalledWith({
      outTradeNo: "payses_123",
      amount: "12.34",
      outRequestNo: "refund_123",
      reason: undefined,
    })
    expect(result.data).toMatchObject({
      last_refund: { refund_fee: "12.34", fund_change: "Y" },
    })
  })

  it("queries the refund when fund_change is not Y", async () => {
    const { provider } = createProvider(options)
    const client = installFakeClient(provider)
    client.refund.mockResolvedValue({ refund_fee: "12.34", fund_change: "N" })
    client.queryRefund.mockResolvedValue({
      refund_status: "REFUND_SUCCESS",
      refund_amount: "12.34",
    })

    const result = await provider.refundPayment({
      amount: 12.34,
      data: sessionData,
      context: { idempotency_key: "refund_123" },
    })

    expect(client.queryRefund).toHaveBeenCalledWith({
      outTradeNo: "payses_123",
      outRequestNo: "refund_123",
    })
    expect(result.data).toMatchObject({
      last_refund_query: {
        refund_status: "REFUND_SUCCESS",
        refund_amount: "12.34",
      },
    })
  })

  it("maps a signed Alipay notification to the captured action", async () => {
    const { provider } = createProvider(options)
    const params: AlipayNotification = {
      app_id: options.app_id,
      out_trade_no: "payses_123",
      trade_no: "2026102522001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
      charset: "utf-8",
      sign_type: "RSA2",
    }
    params.sign = signNotification(params, alipayKeys.privatePem)

    const result = await provider.getWebhookActionAndData({
      data: params,
      rawData: Buffer.from(new URLSearchParams(params).toString()),
      headers: {},
    } as never)

    expect(result.action).toBe(PaymentActions.SUCCESSFUL)
    expect(result.data?.session_id).toBe("payses_123")
    expect(Number(result.data?.amount)).toBe(10.5)
  })

  it("rejects tampered notifications", async () => {
    const { provider, logger } = createProvider(options)
    const params: AlipayNotification = {
      app_id: options.app_id,
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
      sign_type: "RSA2",
    }
    params.sign = signNotification(params, alipayKeys.privatePem)
    params.total_amount = "0.01"

    const result = await provider.getWebhookActionAndData({
      data: params,
      rawData: Buffer.from(new URLSearchParams(params).toString()),
      headers: {},
    } as never)

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("rejects a signed notification whose amount does not match the session", async () => {
    const { provider, logger } = createProvider(options)
    const params: AlipayNotification = {
      app_id: options.app_id,
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
      total_amount: "9.99",
      sign_type: "RSA2",
    }
    params.sign = signNotification(params, alipayKeys.privatePem)

    const result = await provider.getWebhookActionAndData({
      data: params,
      rawData: Buffer.from(new URLSearchParams(params).toString()),
      headers: {},
    } as never)

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not match session amount")
    )
  })

  it("rejects notifications for another Alipay application", async () => {
    const { provider } = createProvider(options)
    const params: AlipayNotification = {
      app_id: "2021999999999999",
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
      sign_type: "RSA2",
    }
    params.sign = signNotification(params, alipayKeys.privatePem)

    const result = await provider.getWebhookActionAndData({
      data: params,
      rawData: Buffer.from(new URLSearchParams(params).toString()),
      headers: {},
    } as never)

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("rejects notifications that are not tied to a Medusa session", async () => {
    const { provider } = createProvider(options)
    const params: AlipayNotification = {
      app_id: options.app_id,
      out_trade_no: "foreign-trade-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
      sign_type: "RSA2",
    }
    params.sign = signNotification(params, alipayKeys.privatePem)

    const result = await provider.getWebhookActionAndData({
      data: params,
      rawData: Buffer.from(new URLSearchParams(params).toString()),
      headers: {},
    } as never)

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
  })
})
