# Doraha Eats — launch checklist

> Legal, tax and licence items below are things to **verify with a CA / lawyer / the provider**.
> They are prompts, not legal advice, and rules change — confirm current requirements.

## 1. Production environment variables (server)
- **Core:** `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (32+ random chars), `TRUST_PROXY=1`
- **CORS:** `CORS_ORIGINS=https://admin.yourdomain.com` (explicit origins, never `*`)
- **Payments:** `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- **Login:** `GOOGLE_CLIENT_IDS` (web, android, ios ids, comma-separated)
- **SMS:** `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`
- **Images:** `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_PUBLIC_BASE_URL` (+ `S3_ENDPOINT` for R2 / B2 / Spaces)
- **Push:** `PUSH_PROVIDER=expo` (+ `EXPO_ACCESS_TOKEN` only if you enabled Expo enhanced security)
- **Safety:** `SEED_DEMO_DATA=false`, change `DEMO_PASSWORD`
- The server refuses to start in production if any of these are unsafe, and prints what to fix.

## 2. Bucket setup (images)
- Create a bucket; allow public READ of objects (or put a CDN in front); keep WRITE private
- Add a CORS rule on the bucket: allow `PUT` from your app origins, headers `Content-Type, Content-Length, Cache-Control`
- Give the access key only `s3:PutObject` on that bucket
- The app must send `sizeBytes` when asking to sign, then `PUT` with exactly the returned headers

## 3. Deploy order
- Merge PRs in order (#3 → #4 → #7 → step-4 PR)
- Back up the database
- Run the pre-check query from `PRODUCTION_SECURITY.md`, then `npm run db:migrate` (migrations 0002, 0003)
- Set env vars, deploy, then check `GET /health`
- Razorpay dashboard: add the webhook (see `PRODUCTION_PAYMENTS.md`), test with TEST keys first
- Never run `npm run seed` against production (it now refuses, but don't try)

## 4. Still-missing product work (be realistic)
- Mobile: Razorpay checkout screen, "Continue with Google", Expo push-token registration + `orders` Android channel
  (all need an Expo **development build**, not Expo Go)
- Admin UI: refund status/button, audit-log viewer
- Password reset by email (needs an email provider)
- Admin 2FA; refresh tokens
- Vendor payouts / settlements and rider earnings payouts (design the money flow first)
- Real-device test of the full order → pay → deliver → refund loop on Razorpay TEST mode

## 5. Business & legal — verify with a professional
- Business entity registration (proprietorship / partnership / LLP / company) and PAN
- GST: whether registration is required for you and how food-delivery/e-commerce-operator rules apply
- Food: each vendor's FSSAI licence/registration (collect and display it); your own FSSAI position as a platform
- Razorpay: business KYC, bank account, accepted business category — live keys depend on this (can take days)
- MSG91 / SMS: DLT registration (entity, sender id, OTP template) — mandatory for Indian SMS
- Customer-facing pages: Privacy Policy, Terms & Conditions, Refund & Cancellation Policy, contact/grievance details
- Vendor agreement and rider agreement (commission, payouts, liability, insurance)
- Payments/tax records: invoices, commission accounting, TDS/TCS applicability for vendors and riders
- Data protection: what personal data you store (phone, address, location), retention, deletion on request

## 6. App stores — verify current rules
- Google Play: developer account, package name `com.dorahaeats.app` (check it matches `app.json`), privacy policy URL,
  Data safety form, target-API requirement, account-deletion option (in-app + web link)
- Apple App Store: developer account, set `ios.bundleIdentifier` in `app.json` (currently missing), privacy policy,
  App Privacy "nutrition labels", account deletion in-app, Sign in with Apple may be required when offering Google sign-in
- Both: app icon, splash, screenshots, store descriptions (English / Hindi / Punjabi), test accounts for reviewers
- Use production `EXPO_PUBLIC_API_URL` (https) in the production build profile

## 7. Day-one operations
- Uptime check on `/health`; alert on 5xx rate and on webhook failures (`"at":"webhook"` log lines)
- Daily: payments stuck in AWAITING_VERIFICATION, refunds with `refundStatus=FAILED`, orders cancelled by the sweeper
- Support phone/WhatsApp number set in admin settings; a written refund SOP
- Start with a small pilot (few vendors, few riders, one area) before opening to everyone
