import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

type PaymentSessionRow = {
  id: string
  status?: string
  payment_collection_id?: string
}

type CartPaymentCollectionRow = {
  cart_id?: string
}

type OrderCartRow = {
  order_id?: string
}

/**
 * Read-only status endpoint for the QR flow. The browser polls it after the
 * customer scans the QR code; Alipay's async notification updates the payment
 * session, and this route exposes only the status plus the final order ID.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id : undefined

  if (!sessionId) {
    res.status(400).json({ message: "session_id is required" })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["id", "status", "payment_collection_id"],
    filters: { id: sessionId },
  })

  const session = (sessions as PaymentSessionRow[])[0]

  if (!session) {
    res.status(404).json({ message: "Payment session not found" })
    return
  }

  let cartId: string | undefined
  let orderId: string | undefined

  if (session.payment_collection_id) {
    const { data: cartLinks } = await query.graph({
      entity: "cart_payment_collection",
      fields: ["cart_id"],
      filters: { payment_collection_id: session.payment_collection_id },
    })

    cartId = (cartLinks as CartPaymentCollectionRow[])[0]?.cart_id

    if (cartId) {
      const { data: orderLinks } = await query.graph({
        entity: "order_cart",
        fields: ["order_id"],
        filters: { cart_id: cartId },
      })

      orderId = (orderLinks as OrderCartRow[])[0]?.order_id
    }
  }

  res.json({
    session_id: session.id,
    status: session.status ?? "pending",
    cart_id: cartId ?? null,
    order_id: orderId ?? null,
  })
}
