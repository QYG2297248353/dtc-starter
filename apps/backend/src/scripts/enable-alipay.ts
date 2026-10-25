/**
 * Enable the Alipay payment providers on every existing region.
 *
 * Fresh databases are handled by the initial data seed. Run this once after
 * adding the Alipay credentials to an existing deployment:
 *
 *   cd apps/backend
 *   pnpm exec medusa exec ./src/scripts/enable-alipay.ts
 *
 * All three providers are enabled by default (PC/H5/QR); merchants can remove
 * the modes they do not need in the Admin > Region > Payment providers.
 * The script is idempotent and also drops the legacy single
 * `pp_alipay_alipay` provider added by earlier builds.
 */
import type { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"

const ALIPAY_PROVIDER_IDS = [
  "pp_alipay_pc",
  "pp_alipay_h5",
  "pp_alipay_qr",
] as const
const LEGACY_PROVIDER_ID = "pp_alipay_alipay"

type RegionWithProviders = {
  id: string
  name?: string
  payment_providers?: { id: string }[]
}

export default async function enableAlipay({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const payment = container.resolve(Modules.PAYMENT)

  const providers = await payment.listPaymentProviders({})
  const registered = new Set(providers.map((provider) => provider.id))
  const missing = ALIPAY_PROVIDER_IDS.filter((id) => !registered.has(id))

  if (missing.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Alipay providers are not registered: ${missing.join(", ")}. Set ` +
        "ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY and ALIPAY_PUBLIC_KEY and restart the backend first."
    )
  }

  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "payment_providers.id"],
  })

  for (const region of regions as RegionWithProviders[]) {
    const current = (region.payment_providers ?? [])
      .map((provider) => provider.id)
      .filter((id) => id !== LEGACY_PROVIDER_ID)
    const next = [...new Set([...current, ...ALIPAY_PROVIDER_IDS])]

    if (
      next.length === current.length &&
      (region.payment_providers ?? []).every(
        (provider) => provider.id !== LEGACY_PROVIDER_ID
      )
    ) {
      logger.info(
        `Region ${region.name ?? region.id} already has all Alipay providers enabled.`
      )
      continue
    }

    await updateRegionsWorkflow(container).run({
      input: {
        selector: { id: region.id },
        update: { payment_providers: next },
      },
    })

    logger.info(
      `Enabled Alipay PC/H5/QR for region ${region.name ?? region.id}.`
    )
  }
}
