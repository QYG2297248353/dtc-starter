import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Alipay asynchronous notification endpoint.
 *
 * Alipay expects the literal body `success`; anything else is retried.
 * Medusa's generic `/hooks/payment/:provider` endpoint returns an empty 200,
 * which makes Alipay retry the same notification for hours, so Alipay is
 * pointed here instead. Verification and amount/session checks still happen in
 * the provider's `getWebhookActionAndData`.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const paymentModule = req.scope.resolve(Modules.PAYMENT)
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const body = (req.body ?? {}) as Record<string, unknown>
    const sessionId =
      typeof body.out_trade_no === "string" ? body.out_trade_no : undefined

    if (!sessionId || !sessionId.startsWith("payses_")) {
      logger.warn("Alipay notification rejected: invalid out_trade_no.")
      res.status(400).type("text/plain").send("failure")
      return
    }

    // The notification does not carry the payment mode. Resolve the provider
    // from the Medusa payment session, then let that provider verify the
    // signature/amount and map the trade status.
    const { data: sessions } = await query.graph({
      entity: "payment_session",
      fields: ["provider_id"],
      filters: { id: sessionId },
    })
    const providerId = (sessions as { provider_id?: string }[])[0]
      ?.provider_id

    if (
      !providerId ||
      !["pp_alipay_pc", "pp_alipay_h5", "pp_alipay_qr"].includes(providerId)
    ) {
      logger.warn(
        `Alipay notification rejected: session ${sessionId} is not an Alipay session.`
      )
      res.status(400).type("text/plain").send("failure")
      return
    }

    const result = await paymentModule.getWebhookActionAndData({
      provider: providerId,
      payload: {
        data: body,
        rawData: req.rawBody,
        headers: req.headers,
      },
    })

    if (
      result.action === PaymentActions.NOT_SUPPORTED ||
      result.action === PaymentActions.FAILED
    ) {
      logger.warn(
        "Alipay notification rejected; responding with failure so it can be retried or investigated."
      )
      res.status(400).type("text/plain").send("failure")
      return
    }

    if (
      result.data?.session_id &&
      (result.action === PaymentActions.AUTHORIZED ||
        result.action === PaymentActions.SUCCESSFUL)
    ) {
      await processPaymentWorkflow(req.scope).run({ input: result })
    }

    res.type("text/plain").send("success")
  } catch (error) {
    logger.error(
      `Alipay notification processing failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    res.status(500).type("text/plain").send("failure")
  }
}
