# Doraha Eats — security & authorization (step 3)

## Holes found and fixed
- **Any rider could read ANY order** (customer phone + full address) via `GET /delivery/orders/:id`.
  - Now: riders see only their own assigned delivery in full.
  - An unclaimed READY order shows pickup info only — phone and exact address are hidden until they accept.
- **Two riders tapping Accept together could both "win".**
  - The loser kept an assignment row and could then mark the order picked up / delivered.
  - Now: order status is the atomic gate (compare-and-set), the loser gets `ALREADY_TAKEN` and no row.
  - A database index backs this up: at most one live rider per order.
- **No way to log out / revoke a stolen token** (7-day JWT).
  - Now: `POST /auth/logout` invalidates every earlier token for that user.
  - The JWT algorithm is pinned to HS256 (blocks `alg=none` / downgrade tricks).
- **Admin actions left no trace** (the `audit_logs` table existed but was never written).
  - Now logged with who/before/after: suspensions, vendor & rider approve/reject, vendor commission/status/zone,
    fee settings, order cancels, refunds, manual payment verification.
- **An admin could suspend themselves or another admin** → blocked.
- **Vendor image upload signing** trusted a client-chosen file name/type (path traversal, HTML/SVG uploads).
  - Now: name ignored, key is random + namespaced to the vendor, only JPEG/PNG/WebP allowed.
- **Login brute force**: added a per-ACCOUNT limit (10 / 15 min) on top of the per-IP limit.
- **Logging**: every request gets `X-Request-Id`; one JSON access-log line per request with NO query string,
  headers or bodies (so no passwords / OTPs / tokens / payment data in logs).
  Error responses carry the request id and never a stack trace; malformed JSON is a 400, not a 500.
- **Proxy setting**: `TRUST_PROXY` (default 1). Set it to the number of reverse proxies in front of the API,
  otherwise all users can share one rate-limit bucket.

## Checked and already correct
- Customers: orders, addresses, cart items, favourites, notifications are all scoped to the owner.
- Vendors: orders and menu items are scoped to their own stall; unapproved vendors can't receive orders.
- Role comes from the database on every request, not from the token.
- Every `/admin`, `/vendor`, `/delivery` route sits behind a role guard.

## Deploy notes
- Migration `0003_security_hardening`: adds `users.token_version` and a unique index on live rider assignments.
  - The index fails if your live DB already has two live riders on one order. Check first:
    `select order_id, count(*) from delivery_assignments where state in ('ACCEPTED','COMPLETED') group by 1 having count(*) > 1;`
    (no rows = safe)
- After deploying, existing logins keep working (missing token version counts as 0).

## Not done yet (be honest before launch)
- Password reset: needs an email provider (columns exist, no flow). Admin-assisted reset is the stopgap.
- Admin 2FA and admin-specific session rules.
- Refresh tokens (current: single 7-day token + logout-all).
- Durable image storage (S3/Cloudinary) — production refuses `STORAGE_PROVIDER=local`, so this blocks launch.
- Push-notification hardening, vendor payouts/settlements, legal checklist, mobile apps.
