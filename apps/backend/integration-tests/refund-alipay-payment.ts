/**
 * Sandbox helper: refund a captured Alipay payment through Medusa.
 *
 *   ALIPAY_TEST_PAYMENT_ID=pay_... \
 *     pnpm exec medusa exec ./integration-tests/refund-alipay-payment.ts
 */
import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refundPaymentWorkflow } from "@medusajs/medusa/core-flows"

export default async function refundAlipayPayment({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const paymentId = process.env.ALIPAY_TEST_PAYMENT_ID

  if (!paymentId) {
    throw new Error("ALIPAY_TEST_PAYMENT_ID is required.")
  }

  const { result } = await refundPaymentWorkflow(container).run({
    input: {
      payment_id: paymentId,
      idempotency_key: `alipay-sandbox-refund-${paymentId}`,
      note: "Alipay sandbox verification refund",
    },
  })

  logger.info(`Refunded payment ${paymentId}: ${JSON.stringify(result)}`)
}
