# Alipay payment provider

Medusa Payment Module provider for Alipay. The module exports three separate
providers so a merchant can enable any subset in the Admin:

| Mode | Provider ID | Alipay API | Result |
| --- | --- | --- | --- |
| `pc` | `pp_alipay_pc` | `alipay.trade.page.pay` | signed cashier URL |
| `h5` | `pp_alipay_h5` | `alipay.trade.wap.pay` | signed mobile cashier URL |
| `qr` | `pp_alipay_qr` | `alipay.trade.precreate` | `qr_code` rendered by the storefront |

It is the fork's replacement for the stock single Manual provider
(`pp_system_default`), not a fulfillment provider.

## Registration

`medusa-config.ts` registers this module only when all three credentials are
present:

```dotenv
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
```

The three providers are registered from the module's service array; no
`id` is set on the config entry, so the IDs are exactly
`pp_alipay_pc`, `pp_alipay_h5` and `pp_alipay_qr`.
Optional variables: `ALIPAY_GATEWAY`, `ALIPAY_NOTIFY_URL`, `ALIPAY_RETURN_URL`,
`ALIPAY_SELLER_ID`, `ALIPAY_SUBJECT_PREFIX`.

## Flow

1. Storefront selects one of the enabled Alipay providers, then initiates a
   payment session. `initiatePayment` returns `data.payment_url` (pc/h5) or
   `data.qr_code` (qr).
2. The customer pays on the Alipay cashier page or by scanning the QR code.
3. Alipay posts an asynchronous notification to `/webhooks/alipay`. The route
   verifies the RSA2 signature, app/seller identity, payment-session ownership,
   and the amount/currency before running `processPaymentWorkflow`. It responds
   with the literal text `success`, which stops Alipay from retrying.
4. For pc/h5, the browser return route completes the cart if the notification
   has not already done so. For qr, the storefront polls
   `/store/alipay/status` and navigates to the order confirmation page.
5. `authorizePayment` queries the Alipay trade and maps `TRADE_SUCCESS` /
   `TRADE_FINISHED` to `captured`. Unpaid trades complete as
   `pending_authorization`.

`out_trade_no` is the Medusa payment session ID, which lets the webhook resolve
the exact cart/order without trusting an arbitrary merchant order reference.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | `ModuleProvider(Modules.PAYMENT, ...)` definition |
| `service.ts` | `AbstractPaymentProvider` implementation, modes, webhook mapping |
| `client.ts` | RSA2 signing, page/wap URLs, precreate, query/refund/close, notify verification |
| `types.ts` | Provider options, mode and Alipay trade types |
| `__tests__/` | Unit tests (no network, generated RSA keys) |

## Tests

```bash
cd apps/backend
TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules \
  pnpm exec jest --runInBand src/modules/payment-alipay
```

The tests generate throwaway RSA key pairs and verify request signing,
notification/response signature checks, amount matching, mode dispatch and
refund behavior.
