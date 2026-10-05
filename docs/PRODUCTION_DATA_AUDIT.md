# Production data audit

## Demo / mock sources found
| Source | Where | Production behaviour |
|---|---|---|
| Demo seed (10 `[DEMO]` vendors, customers, riders, orders, reviews) | `server/src/db/seed.ts` | Never auto-runs. Refuses `NODE_ENV=production` and now also requires `SEED_DEMO_DATA=true` (default is now `false`). |
| Mock UPI provider (`upi_mock`) | `server/src/adapters/payments`, `customer.routes.ts`, `admin.routes.ts` | Server refuses to boot in production unless `PAYMENT_PROVIDER=razorpay`; manual-UTR routes return errors in production. |
| `isDemo` vendor flag | schema, catalog | Customer list, search, vendor page and add-to-cart now exclude `isDemo` vendors in production. |
| Demo credentials hints | admin login page, mobile login screen | Now shown only in dev (`NODE_ENV !== 'production'` / `__DEV__`). |
| Test fakes (fake Razorpay, mocked SMS/Google) | `server/tests` | Test-only, allowed. |

## Changes made
- Rider claim race fixed: partial unique index `assignment_order_active_uniq` (migration `0003_rider_claim_unique.sql`) so only one rider can hold an order; losing claim returns `ALREADY_TAKEN`; failed status move releases the claim; vendor notified only after success.
- Admin `/admin/analytics` now also returns cancelled orders, active deliveries, pending/failed payments, refunds, revenue today, pending vendor/rider approvals; dashboard shows them. Revenue/top-vendor charts exclude cancelled orders.
- `SEED_DEMO_DATA` default `false`.

## Already correct (no change needed)
Prices, fees, tax and totals are computed server-side (`pricing.service.ts`); payment confirmation is via Razorpay webhook + server verification; order status uses compare-and-set; notifications are created from real events; admin stats are SQL aggregates; no `data || demoData` fallbacks found.

## Remaining blockers
1. **Mobile app has no Razorpay checkout.** Online (UPI) orders cannot be paid in production from the app; only the dev mock-UTR screen exists. Needs `react-native-razorpay` (dev build, not Expo Go) wired to `paymentCheckout` from the place-order response. COD works.
2. Favorites tab is a static empty state (no API wiring); notifications list / help screens are stubs per README.
3. Real-time is polling only (5-6 s vendor/rider, order screen poll, 30 s admin). No push: FCM/Expo adapter is stubbed. Acceptable for launch scale; add push for new-order alerts.
4. Vendor app cannot add menu items/photos (API only).
5. Provider config needed before launch: Razorpay keys + webhook secret, MSG91 key/template, non-local storage (S3/Cloudinary), explicit `CORS_ORIGINS`, 32+ char `JWT_SECRET`, maps provider.
6. Concurrency integration tests need `TEST_DATABASE_URL` and were not run here (no Postgres); add a two-rider simultaneous-claim test.
