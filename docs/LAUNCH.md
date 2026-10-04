# Doraha Eats - Launch Guide (real world, Doraha, Ludhiana)

Not legal or tax advice - confirm the "Legal" items with a CA / lawyer.
Windows PowerShell commands throughout.

## Phase 0 - Apply this release (10 min)
1. Backup, then open your repo: `cd C:\path\to\-doraha-eats`
2. Create a branch: `git checkout -b hardening`
3. Copy the files from the patched zip over your repo (overwrite).
4. Remove stray files: `git rm -f sc dir git 18` (ignore "did not match" errors) and `git rm --cached apps/mobile/.env`
5. Install + test: `cd server; npm ci; npm run typecheck; npm test`
6. Commit and push: `cd ..; git add -A; git commit -m "Pre-launch hardening"; git push -u origin hardening`
7. Open a Pull Request; confirm the **CI** check goes green; merge to `main`.

## Phase 1 - Local full test (30 min)
1. Install PostgreSQL 16 locally (set password `devpass`), create DB: `psql -U postgres -c "CREATE DATABASE doraha_eats;"`
2. `cd server; copy .env.example .env` (remove `?schema=public` from DATABASE_URL if migrations complain)
3. `npm run db:migrate; npm run seed; npm run dev`
4. New terminal: `cd server; node tests/acceptance.mjs; node tests/regression.mjs` -> expect 0 failed.
   (If you see RATE_LIMITED, restart the server - login is limited to 20 attempts/15 min/IP.)

## Phase 2 - Production infrastructure
- **Database:** managed PostgreSQL (Neon / Supabase / Render / Railway / AWS RDS). Choose an India/Singapore region. Turn on **automatic daily backups** and test one restore.
- **API host:** Render, Railway or a small VPS. Needs Node 20+, HTTPS (automatic on PaaS), one instance (rate limits are in-memory).
- **Admin panel:** Vercel or Netlify (`apps/admin`).
- **Domain:** e.g. `api.yourdomain.com`, `admin.yourdomain.com`.
- **Monitoring:** free uptime check (UptimeRobot) on `https://api.yourdomain.com/health` + Sentry for errors.

### API environment variables (host dashboard, NOT in git)
| Variable | Value |
|---|---|
| NODE_ENV | production |
| DATABASE_URL | from your DB provider (use the SSL URL) |
| JWT_SECRET | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| CORS_ORIGINS | `https://admin.yourdomain.com` |
| SEED_DEMO_DATA | false |
| DEMO_PASSWORD | any random value |
| UPI_VPA | your real UPI ID |
| SMS_PROVIDER / MSG91_AUTH_KEY / MSG91_TEMPLATE_ID | see Phase 4 |
| TZ | Asia/Kolkata (extra safety; code already uses IST) |

If any value is unsafe, the server prints why and refuses to start.

### Build / start commands
- Build: `npm ci && npm run build && npm run db:migrate`  (migrate needs devDependencies, so run it at build/release time)
- Start: `npm start`
- Root directory: `server`

### First admin (run once, from your PC, pointing at the PRODUCTION DB)
```powershell
cd server
$env:DATABASE_URL="<production url>"
$env:JWT_SECRET="x"*40
$env:ADMIN_EMAIL="you@yourdomain.com"
$env:ADMIN_PASSWORD="<12+ char strong password>"
$env:ADMIN_NAME="Your Name"
npm run create-admin
```
**NEVER run `npm run seed` on production** (it is now blocked, but don't try).

## Phase 3 - Configure the business (in the Admin panel)
1. Log in -> **Zones:** create/activate Doraha with real centre lat/long, radius, delivery fee, minimum order, ETA.
2. **Categories:** add your real categories.
3. **Settings:** platform fee, tax %, commission %, rider payout, cancel window.
4. **Vendors:** onboard each real stall (collect FSSAI number, owner phone, UPI/bank for payouts, real menu + prices + photos).
5. **Riders:** each rider registers in the app as Delivery; approve them in **Riders**.
6. Place 3 real test orders yourself (COD + UPI), end to end, with real phones.

## Phase 4 - SMS (customer login) - START THIS FIRST, it takes days
- Customers log in with phone OTP. In production without SMS, OTP returns 503 and **customers cannot log in**.
- India requires **TRAI DLT registration** (entity + sender ID + approved OTP template) with your SMS provider (MSG91 is implemented).
- Then set `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, redeploy, and **send yourself a real OTP** (the provider call was written from MSG91's v5 docs but could not be tested offline).
- Interim option: customers can use email+password via `/auth/register`, but the mobile app has no sign-up screen for it yet.

## Phase 5 - Mobile app release
1. In `apps/mobile`: set `EXPO_PUBLIC_API_URL=https://api.yourdomain.com/api/v1` (and `extra.apiUrl` in `app.json`). `localhost` will not work on phones.
2. `npm i -g eas-cli; eas login; eas build:configure`
3. `eas build -p android --profile preview` -> installable APK for your pilot riders/vendors (no Play Store needed).
4. For the public: Google Play Console developer account (one-time fee), then `eas build -p android --profile production` (AAB) and submit. Prepare a privacy-policy URL, screenshots, data-safety form (location, phone).
5. iOS needs an Apple Developer account (annual fee) and an `ios` section in `app.json` - do after Android works.

## Phase 6 - Pilot (do NOT skip)
- Week 1-2: **one area, 3-5 stalls, 3-5 riders, you personally supervising**, COD + manual UPI.
- Daily: check admin -> Payments (verify UTRs), Complaints, stuck orders.
- You (admin) are the support line: put your phone number in the app/settings.
- Money: reconcile COD cash from riders and pay vendors manually each day/week using the vendor Earnings screen.

## Legal / compliance checklist (confirm with a CA/lawyer)
- [ ] FSSAI licence/registration for every stall (and understand your own obligations as the platform)
- [ ] Business registration + GST decision (food delivery platforms have specific GST rules)
- [ ] Privacy Policy + Terms + Refund/Cancellation policy (published URL, linked in app)
- [ ] Grievance officer name/contact (IT Rules)
- [ ] Rider agreements; consider accident insurance
- [ ] DLT registration complete (Phase 4)

## KNOWN GAPS - read before you promise anything to vendors
1. **Vendors/riders are alerted only by polling every 5-6 s while the app is open on screen.** If the app is closed/locked, a vendor will MISS orders. The push adapter is a stub. For the pilot, vendors must keep the app open, phone charging, sound on. **Build Expo push notifications next - this is the #1 priority after the pilot starts.**
2. **No real payment gateway:** UPI = customer pays your UPI ID, enters UTR, you verify by checking your bank/UPI app. Razorpay is a stub. Refunds are manual (system only flags REFUNDED).
3. Mobile and admin have no automated tests; test every screen by hand on real phones.
4. Single server instance only (in-memory rate limiting).
5. Login token lasts 7 days with no revocation (suspending a user does block them immediately).
6. No automatic dispatch: riders pick jobs from a list; admin can assign manually.

## Go / No-Go (all must be YES)
- [ ] CI green on `main`; acceptance + regression pass locally
- [ ] Production boots with strong config; `/health` returns ok; uptime monitor on
- [ ] DB backup exists AND a restore was tested
- [ ] Real OTP SMS arrives on a real phone (or you accept admin-created accounts only)
- [ ] Zone, fees, categories set; at least one real vendor with real menu
- [ ] 3 real end-to-end orders done on real phones (COD + UPI), including a cancel
- [ ] Vendors trained to keep app open; your support number is visible
- [ ] Legal checklist done
