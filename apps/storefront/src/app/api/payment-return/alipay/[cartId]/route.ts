import { sdk } from "@lib/config"
import { placeOrder } from "@lib/data/cart"
import { setCartId } from "@lib/data/cookies"
import { unstable_rethrow } from "next/navigation"
import { NextRequest, NextResponse } from "next/server"

/**
 * Alipay redirects the customer here after the cashier page. The cart is
 * completed synchronously so the payment session can be authorized against the
 * Alipay trade query. If the customer closed the browser instead, the async
 * notification completes the cart on the backend a few seconds later.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ cartId: string }> }
) {
  const { cartId } = await context.params
  const { origin, searchParams } = req.nextUrl
  const countryCode = searchParams.get("country_code")
  const prefix = countryCode ? `/${countryCode}` : ""

  const failure = (code: string) =>
    NextResponse.redirect(`${origin}${prefix}/cart?error=${code}`)

  if (!cartId) {
    return failure("payment_failed")
  }

  await setCartId(cartId)

  // The async notification may have completed the cart already (usual for
  // QR, possible for PC/H5). Resolve the resulting order instead of trying to
  // complete a cart that no longer exists.
  const sessionId = searchParams.get("out_trade_no")

  if (sessionId) {
    try {
      const status = await sdk.client.fetch<{ order_id: string | null }>(
        "/store/alipay/status",
        {
          method: "GET",
          query: { session_id: sessionId },
          cache: "no-store",
        }
      )

      if (status.order_id) {
        return NextResponse.redirect(
          `${origin}${prefix}/order/${status.order_id}/confirmed`
        )
      }
    } catch {
      // Fall back to completing the cart below.
    }
  }

  try {
    // Redirects to the order confirmation page when the cart converts.
    await placeOrder(cartId)
  } catch (error) {
    unstable_rethrow(error)

    return failure("order_failed")
  }

  return failure("order_failed")
}
