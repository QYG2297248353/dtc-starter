import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import {
  AlipayH5PaymentProviderService,
  AlipayPcPaymentProviderService,
  AlipayQrPaymentProviderService,
} from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  // Three separate providers so a merchant can enable any subset in the Admin
  // (Region > Payment providers): Alipay (PC), Alipay (H5), Alipay (QR).
  services: [
    AlipayPcPaymentProviderService,
    AlipayH5PaymentProviderService,
    AlipayQrPaymentProviderService,
  ],
})
