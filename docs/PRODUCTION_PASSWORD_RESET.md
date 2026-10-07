# Password reset + India time fix

## Password reset (by email)
- App/website calls `POST /api/v1/auth/password/forgot` with `{ "email": "..." }` — always answers `{ "sent": true }`
- Email contains a link to `APP_URL/reset-password?uid=...&token=...` (a small page served by the API itself)
- Customer enters a new password (8+ chars) → done; no app update needed for the page itself
- Link is single-use, valid `PASSWORD_RESET_TOKEN_TTL_MIN` minutes (default 30); only a hash is stored
- A successful reset logs the account out everywhere (old tokens stop working)
- One reset email per minute per account; suspended accounts get none
- API also available for the app: `POST /api/v1/auth/password/reset` `{ userId, token, newPassword }`

## Render environment variables to add
- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY=<from resend.com>`
- `EMAIL_FROM=Doraha Eats <no-reply@yourdomain.com>`  (needs a domain verified in Resend; a free-tier test sender works for trying)
- `APP_URL=https://doraha-eats.onrender.com`
- Until these are set, production answers `503 EMAIL_NOT_CONFIGURED` (it never prints reset links in logs and the server still boots)

## Still to do in the mobile app
- A "Forgot password?" link on the login screen that calls `/auth/password/forgot` and tells the user to check their email

## India time fix
- Cloud servers run in UTC. Opening hours, "open now" and "today's earnings" used the server clock, so shops
  would appear open/closed about 5½ hours off. They now use India time (`lib/time.ts`) on any server.
