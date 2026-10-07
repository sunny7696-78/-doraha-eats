# Doraha Eats — production payments (Razorpay)

## How an online order now works
- App calls `POST /orders` (`paymentMethod: "UPI"`, header `Idempotency-Key: <uuid per checkout>`)
- Server prices the cart itself, creates the order + a Razorpay order for that exact amount
- Response includes `order.paymentCheckout` → open the Razorpay checkout with it
- After checkout the app calls `POST /orders/:id/payment/verify` with the 3 Razorpay values
  (server checks the signature, then fetches the payment from Razorpay and compares order/amount/currency)
- Razorpay's webhook is the final authority and also covers closed apps / lost connections
- Vendor sees and is notified of the order **only after payment is confirmed**
- Failed or abandoned: `POST /orders/:id/payment/retry` re-uses the same Razorpay order (no double charge)
- Unpaid orders auto-cancel after `PAYMENT_WINDOW_MINUTES` (default 30)
- Cancelling a paid order refunds automatically; the payment becomes `REFUNDED` only when Razorpay confirms
- COD is unchanged

## Razorpay dashboard setup (do once, test mode first)
- Settings → API Keys → generate keys → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
- Settings → Webhooks → add:
  - URL: `https://<your-api-domain>/api/v1/payments/razorpay/webhook`
  - Secret: any long random string → same value in `RAZORPAY_WEBHOOK_SECRET`
  - Events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`
- Keep auto-capture ON (default)
- Live keys need completed Razorpay KYC (business verification) — start early, it can take days

## Deploy steps (PowerShell, from `server\`)
- `npm ci`
- `npm run build`
- Back up the database first (host snapshot or `pg_dump`)
- `npm run db:migrate`   (migration `0002_payments_razorpay` only ADDS columns/tables; no data is changed)
- Set production env vars (see `.env.example`), then `npm start`
- The server refuses to boot in production on unsafe settings and prints exactly what to fix

## Test it (Razorpay TEST keys + a public HTTPS URL, e.g. your staging host)
- Place an online order → pay with a Razorpay test card/UPI → order turns PAID, vendor is notified
- Cancel a paid order → refund shows in Razorpay dashboard → payment becomes REFUNDED
- Close the app mid-payment → webhook still confirms the order
- Automated tests: `$env:TEST_DATABASE_URL="postgres://..."; npm test`

## Still needed (not part of this change)
- Mobile app: Razorpay checkout screen (needs `react-native-razorpay` → an Expo **development build**, not Expo Go),
  send `Idempotency-Key`, call `/payment/verify`, show retry on failure
- Admin UI: refund status + button for `POST /admin/payments/:id/refund` on cancelled orders
- Vendor payouts/settlements (business + legal decision)
- Real SMS provider (MSG91), durable image storage (S3/Cloudinary), Google sign-in, OTP hardening
