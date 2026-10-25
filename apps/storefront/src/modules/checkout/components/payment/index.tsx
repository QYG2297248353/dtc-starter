"use client"
import { RadioGroup } from "@headlessui/react"
import { isAlipay, isAlipayQr, isStripeLike, paymentInfoMap } from "@lib/constants"
import { sdk } from "@lib/config"
import { initiatePaymentSession } from "@lib/data/cart"
import { CheckCircleSolid, CreditCard } from "@medusajs/icons"
import ErrorMessage from "@modules/checkout/components/error-message"
import PaymentContainer, {
  StripePaymentContainer,
} from "@modules/checkout/components/payment-container"
import Divider from "@modules/common/components/divider"
import {
  Button,
  Container,
  Heading,
  Text,
  clx,
} from "@modules/common/components/ui"
import { HttpTypes } from "@medusajs/types"
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation"
import { QRCodeSVG } from "qrcode.react"
import { useCallback, useEffect, useState } from "react"

type AlipaySessionData = {
  session_id?: string
  method?: "pc" | "h5" | "qr"
  payment_url?: string
  qr_code?: string
}

const Payment = ({
  cart,
  availablePaymentMethods,
}: {
  cart: HttpTypes.StoreCart
  availablePaymentMethods: { id: string }[]
}) => {
  const activeSession = cart.payment_collection?.payment_sessions?.find(
    (paymentSession) => paymentSession.status === "pending"
  )

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paymentComplete, setPaymentComplete] = useState(false)
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState(
    activeSession?.provider_id ?? ""
  )
  const [alipayData, setAlipayData] = useState<AlipaySessionData | null>(
    isAlipay(activeSession?.provider_id)
      ? (activeSession?.data as AlipaySessionData)
      : null
  )

  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { countryCode } = useParams<{ countryCode?: string }>()

  const isOpen = searchParams.get("step") === "payment"

  // fork-addition: Alipay sessions are created as soon as the provider is
  // selected so QR data / cashier URL is ready for the review step.
  const initiateSession = async (providerId: string) => {
    const response = await initiatePaymentSession(cart, {
      provider_id: providerId,
      ...(isAlipay(providerId)
        ? {
            data: {
              return_url: `${window.location.origin}/api/payment-return/alipay/${
                cart.id
              }${countryCode ? `?country_code=${countryCode}` : ""}`,
            },
          }
        : {}),
    })

    if (isAlipay(providerId)) {
      const session = response.payment_collection?.payment_sessions?.find(
        (paymentSession) => paymentSession.status === "pending"
      )
      setAlipayData((session?.data as AlipaySessionData) ?? null)
    }

    return response
  }

  const setPaymentMethod = async (method: string) => {
    setError(null)
    setSelectedPaymentMethod(method)
    if (isStripeLike(method) || isAlipay(method)) {
      try {
        await initiateSession(method)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const paidByGiftcard = !!(
    (cart as unknown as Record<string, unknown>)?.gift_cards && ((cart as unknown as Record<string, unknown>)?.gift_cards as unknown[])?.length > 0 && cart?.total === 0
  )

  const paymentReady =
    (activeSession && (cart?.shipping_methods?.length ?? 0) !== 0) || paidByGiftcard
  const isQrPayment = isAlipayQr(selectedPaymentMethod)

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams)
      params.set(name, value)

      return params.toString()
    },
    [searchParams]
  )

  const handleEdit = () => {
    router.push(pathname + "?" + createQueryString("step", "payment"), {
      scroll: false,
    })
  }

  const handleSubmit = async () => {
    setIsLoading(true)
    try {
      const shouldInputPaymentDetails =
        isStripeLike(selectedPaymentMethod) && !activeSession

      const checkActiveSession =
        activeSession?.provider_id === selectedPaymentMethod

      if (!checkActiveSession) {
        await initiateSession(selectedPaymentMethod)
      }

      if (!shouldInputPaymentDetails) {
        return router.push(
          pathname + "?" + createQueryString("step", "review"),
          {
            scroll: false,
          }
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setError(null)
  }, [isOpen])

  // fork-addition: QR payments don't redirect the browser. Poll the backend
  // status endpoint (the webhook updates the session) and navigate to the order
  // confirmation as soon as Alipay confirms payment.
  useEffect(() => {
    const sessionId = alipayData?.session_id

    if (!isAlipayQr(selectedPaymentMethod) || !sessionId) {
      return
    }

    let cancelled = false

    const checkStatus = async () => {
      try {
        const result = await sdk.client.fetch<{
          status: string
          order_id: string | null
        }>("/store/alipay/status", {
          method: "GET",
          query: { session_id: sessionId },
          cache: "no-store",
        })

        if (cancelled) {
          return
        }

        if (result.order_id) {
          router.push(
            `/${countryCode ?? ""}/order/${result.order_id}/confirmed`
          )
          return
        }

        if (result.status === "canceled") {
          setError("The Alipay payment was closed or canceled.")
        }
      } catch {
        // Transient polling errors are ignored; the next tick retries.
      }
    }

    void checkStatus()
    const timer = setInterval(checkStatus, 3000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [
    alipayData?.session_id,
    countryCode,
    router,
    selectedPaymentMethod,
  ])

  return (
    <div className="bg-white">
      <div className="flex flex-row items-center justify-between mb-6">
        <Heading
          level="h2"
          className={clx(
            "flex flex-row text-3xl-regular gap-x-2 items-baseline",
            {
              "opacity-50 pointer-events-none select-none":
                !isOpen && !paymentReady,
            }
          )}
        >
          Payment
          {!isOpen && paymentReady && <CheckCircleSolid />}
        </Heading>
        {!isOpen && paymentReady && (
          <Text>
            <button
              onClick={handleEdit}
              className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
              data-testid="edit-payment-button"
            >
              Edit
            </button>
          </Text>
        )}
      </div>
      <div>
        <div className={isOpen ? "block" : "hidden"}>
          {!paidByGiftcard && availablePaymentMethods?.length && (
            <>
              <RadioGroup
                value={selectedPaymentMethod}
                onChange={(value: string) => setPaymentMethod(value)}
              >
                {availablePaymentMethods.map((paymentMethod) => (
                  <div key={paymentMethod.id}>
                    {isStripeLike(paymentMethod.id) ? (
                      <StripePaymentContainer
                        paymentProviderId={paymentMethod.id}
                        selectedPaymentOptionId={selectedPaymentMethod}
                        paymentInfoMap={paymentInfoMap}
                        setError={setError}
                        setPaymentComplete={setPaymentComplete}
                      />
                    ) : (
                      <PaymentContainer
                        paymentInfoMap={paymentInfoMap}
                        paymentProviderId={paymentMethod.id}
                        selectedPaymentOptionId={selectedPaymentMethod}
                      />
                    )}
                  </div>
                ))}
              </RadioGroup>

              {isAlipayQr(selectedPaymentMethod) && (
                <div className="mt-2 mb-4 rounded-rounded border border-ui-border-base p-4">
                  <Text className="txt-medium-plus text-ui-fg-base mb-2">
                    Scan with the Alipay app
                  </Text>

                  {alipayData?.qr_code ? (
                    <div className="flex flex-col items-start gap-2">
                      <div className="bg-white p-2 rounded-rounded border border-ui-border-base">
                        <QRCodeSVG value={alipayData.qr_code} size={176} />
                      </div>
                      <Text className="txt-medium text-ui-fg-subtle">
                        This page updates automatically after payment.
                      </Text>
                    </div>
                  ) : (
                    <Text className="txt-medium text-ui-fg-subtle">
                      Generating Alipay QR code...
                    </Text>
                  )}
                </div>
              )}
            </>
          )}

          {paidByGiftcard && (
            <div className="flex flex-col w-1/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment method
              </Text>
              <Text
                className="txt-medium text-ui-fg-subtle"
                data-testid="payment-method-summary"
              >
                Gift card
              </Text>
            </div>
          )}

          <ErrorMessage
            error={error}
            data-testid="payment-method-error-message"
          />

          <Button
            size="large"
            className="mt-6"
            onClick={handleSubmit}
            isLoading={isLoading}
            disabled={
              (isStripeLike(selectedPaymentMethod) && !paymentComplete) ||
              isQrPayment ||
              (!selectedPaymentMethod && !paidByGiftcard)
            }
            data-testid="submit-payment-button"
          >
            {isQrPayment
              ? "Waiting for Alipay payment..."
              : !activeSession && isStripeLike(selectedPaymentMethod)
                ? "Enter payment details"
                : "Continue to review"}
          </Button>
        </div>

        <div className={isOpen ? "hidden" : "block"}>
          {cart && paymentReady && activeSession ? (
            <div className="flex items-start gap-x-1 w-full">
              <div className="flex flex-col w-1/3">
                <Text className="txt-medium-plus text-ui-fg-base mb-1">
                  Payment method
                </Text>
                <Text
                  className="txt-medium text-ui-fg-subtle"
                  data-testid="payment-method-summary"
                >
                  {paymentInfoMap[activeSession?.provider_id]?.title ||
                    activeSession?.provider_id}
                </Text>
              </div>
              <div className="flex flex-col w-1/3">
                <Text className="txt-medium-plus text-ui-fg-base mb-1">
                  Payment details
                </Text>
                <div
                  className="flex gap-2 txt-medium text-ui-fg-subtle items-center"
                  data-testid="payment-details-summary"
                >
                  <Container className="flex items-center h-7 w-fit p-2 bg-ui-button-neutral-hover">
                    {paymentInfoMap[selectedPaymentMethod]?.icon || (
                      <CreditCard />
                    )}
                  </Container>
                  <Text>Another step will appear</Text>
                </div>
              </div>
            </div>
          ) : paidByGiftcard ? (
            <div className="flex flex-col w-1/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment method
              </Text>
              <Text
                className="txt-medium text-ui-fg-subtle"
                data-testid="payment-method-summary"
              >
                Gift card
              </Text>
            </div>
          ) : null}
        </div>
      </div>
      <Divider className="mt-8" />
    </div>
  )
}

export default Payment
