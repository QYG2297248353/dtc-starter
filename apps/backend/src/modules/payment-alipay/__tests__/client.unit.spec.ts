import {
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto"

import {
  AlipayApiError,
  AlipayClient,
  parseNotification,
} from "../client"
import type { AlipayNotification, AlipayOptions } from "../types"

type KeyPair = {
  privatePem: string
  publicPem: string
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
  privatePem: string,
  includeSignType = true
): string {
  const content = Object.keys(params)
    .filter(
      (key) =>
        key !== "sign" && (includeSignType || key !== "sign_type")
    )
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&")

  return createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(privatePem, "base64")
}

function createClient(
  overrides: Partial<AlipayOptions> = {}
): { client: AlipayClient; appKeys: KeyPair; alipayKeys: KeyPair } {
  const appKeys = generateKeyPair()
  const alipayKeys = generateKeyPair()

  const client = new AlipayClient({
    app_id: "2021000000000000",
    private_key: appKeys.privatePem,
    alipay_public_key: alipayKeys.publicPem,
    ...overrides,
  })

  return { client, appKeys, alipayKeys }
}

function mockFetchResponse(client: AlipayClient, raw: string, status = 200) {
  const target = client as unknown as {
    fetchImpl: typeof fetch
  }

  target.fetchImpl = jest.fn(async () => {
    return new Response(raw, {
      status,
      headers: { "content-type": "application/json" },
    })
  })
}

describe("AlipayClient", () => {
  it("builds a signed page-pay URL", () => {
    const { client, appKeys } = createClient({
      notify_url: "https://api.example.com/hooks/payment/alipay_alipay",
    })

    const url = new URL(
      client.createPagePayUrl({
        outTradeNo: "payses_123",
        amount: "10.50",
        currency: "EUR",
        subject: "Order payses_123",
        returnUrl: "https://shop.example.com/api/payment-return/alipay",
      })
    )

    expect(url.origin + url.pathname).toBe(
      "https://openapi.alipay.com/gateway.do"
    )

    const params = Object.fromEntries(url.searchParams.entries())
    expect(params.app_id).toBe("2021000000000000")
    expect(params.method).toBe("alipay.trade.page.pay")
    expect(params.sign_type).toBe("RSA2")
    expect(params.charset).toBe("utf-8")
    expect(params.return_url).toBe(
      "https://shop.example.com/api/payment-return/alipay"
    )
    expect(params.notify_url).toBe(
      "https://api.example.com/hooks/payment/alipay_alipay"
    )

    const bizContent = JSON.parse(params.biz_content)
    expect(bizContent).toMatchObject({
      out_trade_no: "payses_123",
      total_amount: "10.50",
      currency: "EUR",
      product_code: "FAST_INSTANT_TRADE_PAY",
    })

    const content = Object.keys(params)
      .filter((key) => key !== "sign")
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&")

    const verifier = createVerify("RSA-SHA256")
    verifier.update(content, "utf8")
    expect(verifier.verify(appKeys.publicPem, Buffer.from(params.sign, "base64"))).toBe(
      true
    )
  })

  it("builds an H5 wap-pay URL with the wap product code", () => {
    const { client } = createClient()
    const url = new URL(
      client.createRedirectUrl("h5", {
        outTradeNo: "payses_123",
        amount: "0.01",
        currency: "CNY",
        subject: "Order payses_123",
      })
    )

    const params = Object.fromEntries(url.searchParams.entries())
    expect(params.method).toBe("alipay.trade.wap.pay")
    expect(JSON.parse(params.biz_content)).toMatchObject({
      product_code: "QUICK_WAP_WAY",
      total_amount: "0.01",
    })
  })

  it("pre-creates a QR trade", async () => {
    const { client } = createClient()
    mockFetchResponse(
      client,
      JSON.stringify({
        alipay_trade_precreate_response: {
          code: "10000",
          msg: "Success",
          out_trade_no: "payses_123",
          qr_code: "https://qr.alipay.com/sandbox-qr-1",
        },
      })
    )

    await expect(
      client.precreate({
        outTradeNo: "payses_123",
        amount: "0.01",
        currency: "CNY",
        subject: "Order payses_123",
        notifyUrl: "https://api.example.com/webhooks/alipay",
      })
    ).resolves.toMatchObject({
      qr_code: "https://qr.alipay.com/sandbox-qr-1",
    })
  })

  it("queries the final refund status", async () => {
    const { client } = createClient()
    mockFetchResponse(
      client,
      JSON.stringify({
        alipay_trade_fastpay_refund_query_response: {
          code: "10000",
          msg: "Success",
          out_request_no: "refund_1",
          refund_amount: "5.00",
          refund_status: "REFUND_SUCCESS",
          total_amount: "10.00",
        },
      })
    )

    await expect(
      client.queryRefund({
        outTradeNo: "payses_123",
        outRequestNo: "refund_1",
      })
    ).resolves.toMatchObject({
      refund_status: "REFUND_SUCCESS",
      refund_amount: "5.00",
    })
  })

  it("verifies notifications with and without sign_type in the signed content", () => {
    const { client, alipayKeys } = createClient()
    const base = {
      app_id: "2021000000000000",
      out_trade_no: "payses_123",
      trade_no: "2026102522001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
      sign_type: "RSA2",
      charset: "utf-8",
    }

    const withSignType: AlipayNotification = {
      ...base,
      sign: signNotification(base, alipayKeys.privatePem, true),
    }
    expect(client.verifyNotification(withSignType)).toBe(true)

    const withoutSignType: AlipayNotification = {
      ...base,
      sign: signNotification(base, alipayKeys.privatePem, false),
    }
    expect(client.verifyNotification(withoutSignType)).toBe(true)

    const tampered = { ...withSignType, total_amount: "0.01" }
    expect(client.verifyNotification(tampered)).toBe(false)
  })

  it("parses form-encoded and JSON notification bodies", () => {
    expect(
      parseNotification(
        Buffer.from(
          "out_trade_no=payses_123&total_amount=10.50&trade_status=TRADE_SUCCESS"
        )
      )
    ).toEqual({
      out_trade_no: "payses_123",
      total_amount: "10.50",
      trade_status: "TRADE_SUCCESS",
    })

    expect(
      parseNotification({
        out_trade_no: "payses_123",
        total_amount: 10.5,
        tags: ["a"],
      })
    ).toEqual({
      out_trade_no: "payses_123",
      total_amount: "10.5",
      tags: "a",
    })
  })

  it("queries a trade and verifies the response signature", async () => {
    const { client, alipayKeys } = createClient()
    const payload = {
      code: "10000",
      msg: "Success",
      out_trade_no: "payses_123",
      trade_no: "2026102522001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
    }
    const payloadJson = JSON.stringify(payload)
    const sign = createSign("RSA-SHA256")
      .update(payloadJson, "utf8")
      .sign(alipayKeys.privatePem, "base64")

    mockFetchResponse(
      client,
      `{"alipay_trade_query_response":${payloadJson},"sign":"${sign}"}`
    )

    await expect(client.queryTrade("payses_123")).resolves.toMatchObject({
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.50",
    })
  })

  it("rejects a response with an invalid signature", async () => {
    const { client } = createClient()
    const payloadJson = JSON.stringify({
      code: "10000",
      out_trade_no: "payses_123",
      trade_status: "TRADE_SUCCESS",
    })

    mockFetchResponse(
      client,
      `{"alipay_trade_query_response":${payloadJson},"sign":"bm90LWEtc2lnbg=="}`
    )

    await expect(client.queryTrade("payses_123")).rejects.toBeInstanceOf(
      AlipayApiError
    )
  })

  it("returns null when Alipay reports a missing trade", async () => {
    const { client } = createClient()
    const payloadJson = JSON.stringify({
      code: "40004",
      msg: "Business Failed",
      sub_code: "ACQ.TRADE_NOT_EXIST",
      sub_msg: "Trade not exist",
    })

    mockFetchResponse(
      client,
      `{"alipay_trade_query_response":${payloadJson}}`
    )

    await expect(client.queryTrade("payses_missing")).resolves.toBeNull()
  })

  it("surfaces a signed gateway error response", async () => {
    const { client, alipayKeys } = createClient()
    const payloadJson = JSON.stringify({
      code: "40002",
      msg: "Invalid Arguments",
      sub_code: "isv.invalid-signature",
      sub_msg: "验签出错",
    })
    const sign = createSign("RSA-SHA256")
      .update(payloadJson, "utf8")
      .sign(alipayKeys.privatePem, "base64")

    mockFetchResponse(
      client,
      `{"error_response":${payloadJson},"sign":"${sign}"}`
    )

    await expect(client.queryTrade("payses_123")).rejects.toMatchObject({
      code: "40002",
      subCode: "isv.invalid-signature",
    })
  })

  it("refunds with an idempotent out_request_no", async () => {
    const { client } = createClient()
    const payloadJson = JSON.stringify({
      code: "10000",
      msg: "Success",
      out_trade_no: "payses_123",
      refund_fee: "5.00",
      fund_change: "Y",
    })
    mockFetchResponse(
      client,
      `{"alipay_trade_refund_response":${payloadJson}}`
    )

    const refund = await client.refund({
      outTradeNo: "payses_123",
      amount: "5.00",
      outRequestNo: "refund_1",
    })

    expect(refund).toMatchObject({ refund_fee: "5.00", fund_change: "Y" })
  })
})
