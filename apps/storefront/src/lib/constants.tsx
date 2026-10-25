import { CreditCard } from "@medusajs/icons"
import Alipay from "@modules/common/icons/alipay"
import Bancontact from "@modules/common/icons/bancontact"
import Ideal from "@modules/common/icons/ideal"
import PayPal from "@modules/common/icons/paypal"
import React from "react"

/* Map of payment provider_id to their title and icon. Add in any payment providers you want to use. */
export const paymentInfoMap: Record<
  string,
  { title: string; icon: React.JSX.Element }
> = {
  pp_stripe_stripe: {
    title: "Credit card",
    icon: <CreditCard />,
  },
  "pp_medusa-payments_default": {
    title: "Credit card",
    icon: <CreditCard />,
  },
  "pp_stripe-ideal_stripe": {
    title: "iDeal",
    icon: <Ideal />,
  },
  "pp_stripe-bancontact_stripe": {
    title: "Bancontact",
    icon: <Bancontact />,
  },
  pp_paypal_paypal: {
    title: "PayPal",
    icon: <PayPal />,
  },
  // fork-addition: three Alipay providers (see apps/backend/src/modules/payment-alipay)
  pp_alipay_pc: {
    title: "Alipay (PC)",
    icon: <Alipay />,
  },
  pp_alipay_h5: {
    title: "Alipay (H5)",
    icon: <Alipay />,
  },
  pp_alipay_qr: {
    title: "Alipay (QR)",
    icon: <Alipay />,
  },
  pp_system_default: {
    title: "Manual Payment",
    icon: <CreditCard />,
  },
  // Add more payment providers here
}

// This only checks if it is native stripe or medusa payments for card payments, it ignores the other stripe-based providers
export const isStripeLike = (providerId?: string) => {
  return (
    providerId?.startsWith("pp_stripe_") || providerId?.startsWith("pp_medusa-")
  )
}

export const isPaypal = (providerId?: string) => {
  return providerId?.startsWith("pp_paypal")
}
// fork-addition: Alipay providers (PC/H5 redirect, QR pre-create).
export const isAlipay = (providerId?: string) => {
  return providerId?.startsWith("pp_alipay")
}
export const isAlipayQr = (providerId?: string) => {
  return providerId?.startsWith("pp_alipay_qr")
}
export const isManual = (providerId?: string) => {
  return providerId?.startsWith("pp_system_default")
}

// Add currencies that don't need to be divided by 100
export const noDivisionCurrencies = [
  "krw",
  "jpy",
  "vnd",
  "clp",
  "pyg",
  "xaf",
  "xof",
  "bif",
  "djf",
  "gnf",
  "kmf",
  "mga",
  "rwf",
  "xpf",
  "htg",
  "vuv",
  "xag",
  "xdr",
  "xau",
]
