# Doraha Eats — production auth (Google, OTP, accounts)

## Google sign-in (customers only)
- App gets a Google ID token → `POST /api/v1/auth/google` with `{ "idToken": "..." }`
- Server verifies it with Google's official library (signature, issuer, expiry, and that the
  audience is one of YOUR client ids), requires a verified email, then applies:
  - googleId already known → log in
  - verified email matches a customer → Google is linked to that account (no duplicate)
  - no match → new customer + profile + cart
  - email belongs to admin / vendor / rider → refused (never auto-linked or converted)
- Response is the same `{ user, token }` as every other login
- Client-sent email / name / role / googleId are never trusted
- Set `GOOGLE_CLIENT_IDS` = comma-separated list of your Web, Android and iOS OAuth client ids
- Google Cloud Console: create OAuth consent screen + one client id per platform
  (Android needs your app's SHA-1 + package `com.dorahaeats.app`)

## Phone OTP
- Numbers are normalised to `+91XXXXXXXXXX`; anything else is rejected
- Limits per phone (database-backed, not just per IP): 60 s resend cooldown, 5 per hour, 10 per day
- Code: 6 digits from a secure random generator, valid 5 minutes, single use
- 5 wrong guesses lock the code; guesses are counted atomically, so parallel requests can't exceed it
- Admin and vendor accounts can't use phone codes; suspended accounts are refused
- If the SMS fails to send, the code is discarded
- Real SMS: `SMS_PROVIDER=msg91` + `MSG91_AUTH_KEY` + `MSG91_TEMPLATE_ID`
  - India needs a DLT-registered sender id + OTP template (variable name `otp`) — do this early
  - Production will not start with `SMS_PROVIDER=console`; the console provider also refuses to run in production

## Accounts
- Emails are stored lowercase and matched case-insensitively; phones are normalised
- Registration creates user + profile + cart in one transaction; concurrent duplicates → one account
- New passwords must be 8+ characters

## Not done in this change
- Mobile "Continue with Google" button (needs a native Google Sign-In library → Expo development build)
- Password reset flow, refresh tokens / server-side logout, admin 2FA (next step: security & authorization)
