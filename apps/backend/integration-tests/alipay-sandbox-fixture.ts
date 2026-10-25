/**
 * Sandbox-only fixture for end-to-end Alipay testing.
 *
 * Creates (idempotently) a CNY region, enables Alipay there, and creates a
 * 0.01 CNY product. Run against a throwaway database only:
 *
 *   pnpm exec medusa exec ./integration-tests/alipay-sandbox-fixture.ts
 */
import type { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import {
  createProductsWorkflow,
  createRegionsWorkflow,
  createShippingOptionsWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

const HANDLE = "alipay-sandbox-item"
const PRODUCT_AMOUNT = Number(process.env.ALIPAY_SANDBOX_PRODUCT_AMOUNT ?? "0.01")
const SHIPPING_AMOUNT = Number(
  process.env.ALIPAY_SANDBOX_SHIPPING_AMOUNT ?? "0.01"
)

export default async function alipaySandboxFixture({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: stores } = await query.graph({
    entity: "store",
    fields: [
      "id",
      "default_sales_channel_id",
      "supported_currencies.currency_code",
    ],
  })
  const store = stores[0] as {
    id: string
    default_sales_channel_id: string
    supported_currencies?: { currency_code: string }[]
  }

  const currencies = store.supported_currencies ?? []
  if (!currencies.some((currency) => currency.currency_code === "cny")) {
    await updateStoresWorkflow(container).run({
      input: {
        selector: { id: store.id },
        update: {
          supported_currencies: [
            ...currencies.map((currency) => ({
              currency_code: currency.currency_code,
              is_default: currency.currency_code === "eur",
            })),
            { currency_code: "cny", is_default: false },
          ],
        },
      },
    })
    logger.info("Added CNY to the store supported currencies.")
  }

  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "currency_code"],
  })
  let region = (
    regions as { id: string; name: string; currency_code: string }[]
  ).find((item) => item.currency_code === "cny")

  if (!region) {
    const { result } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Alipay Sandbox CNY",
            currency_code: "cny",
            countries: ["cn"],
            payment_providers: ["pp_alipay_pc", "pp_alipay_h5", "pp_alipay_qr", "pp_system_default"],
          },
        ],
      },
    })
    region = result[0]
    logger.info(`Created CNY region ${region.id}.`)
  } else {
    logger.info(`CNY region already exists: ${region.id}.`)
  }

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
    filters: { handle: HANDLE },
  })

  const { data: profiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  })

  if (products.length) {
    logger.info(`Sandbox product already exists: ${products[0].id}.`)
  } else {
    const { result } = await createProductsWorkflow(container).run({
      input: {
        products: [
          {
            title: "Alipay Sandbox Item",
            handle: HANDLE,
            description: "0.01 CNY item used for Alipay sandbox verification.",
            status: ProductStatus.PUBLISHED,
            shipping_profile_id: profiles[0].id,
            options: [{ title: "Pack", values: ["Single"] }],
            variants: [
              {
                title: "Single",
                sku: "ALIPAY-SANDBOX-1",
                manage_inventory: false,
                options: { Pack: "Single" },
                prices: [{ amount: PRODUCT_AMOUNT, currency_code: "cny" }],
              },
            ],
            sales_channels: [{ id: store.default_sales_channel_id }],
          },
        ],
      },
    })

    logger.info(
      `Created sandbox product ${result[0].id} in region ${region.id}.`
    )
  }

  const fulfillment = container.resolve(Modules.FULFILLMENT)
  const zones = await fulfillment.listServiceZones(
    {},
    { relations: ["geo_zones"] }
  )
  const zone = zones[0]

  if (!zone) {
    throw new Error("No fulfillment service zone found.")
  }

  const geoZones = (zone.geo_zones ?? []).map((geoZone) => ({
    country_code: geoZone.country_code,
    type: "country" as const,
  }))

  if (!geoZones.some((geoZone) => geoZone.country_code === "cn")) {
    await fulfillment.updateServiceZones(zone.id, {
      name: zone.name,
      geo_zones: [
        ...geoZones,
        { country_code: "cn", type: "country" },
      ],
    })
    logger.info("Added CN to the sandbox service zone.")
  }

  const { data: shippingOptions } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "name"],
  })

  if (
    !(shippingOptions as { name: string }[]).some(
      (option) => option.name === "Alipay Sandbox Shipping"
    )
  ) {
    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: "Alipay Sandbox Shipping",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: zone.id,
          shipping_profile_id: profiles[0].id,
          type: {
            label: "Sandbox",
            description: "Sandbox shipping for Alipay testing.",
            code: "alipay-sandbox",
          },
          prices: [{ currency_code: "cny", amount: SHIPPING_AMOUNT }],
          rules: [
            {
              attribute: "enabled_in_store",
              value: "true",
              operator: "eq",
            },
            {
              attribute: "is_return",
              value: "false",
              operator: "eq",
            },
          ],
        },
      ],
    })
    logger.info("Created the CNY sandbox shipping option.")
  }
}
