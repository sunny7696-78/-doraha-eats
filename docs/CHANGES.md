# Changes in this release (pre-launch hardening)

All verified on a real PostgreSQL: 30 unit + 46 acceptance + 20 regression tests pass; typecheck clean; `npm audit` 0 vulnerabilities.

## Money / correctness
- UPI: customer can no longer self-mark an order PAID. UTR is format-checked (12-22 alphanumeric), cannot be reused across orders; only an admin can verify (and only once, only if a UTR exists, never on cancelled orders).
- Rider claim race fixed: READY->ASSIGNED is an atomic compare-and-set, committed with the assignment row. DB partial unique index (migration `0002`) guarantees one live rider per order.
- Every status change is now compare-and-set (no lost updates / split-brain timelines).
- Vendors/customers cannot cancel once the rider has picked up; only an admin can. Cancelling closes an unpaid payment (FAILED) or flags a paid one REFUNDED (**the actual money refund is still manual**).
- Notification failures no longer turn a committed order into a 500.

## Real-world (India)
- All business time uses India Standard Time. Before: on a UTC cloud server, stalls opened/closed 5.5 h off, and "today's earnings" rolled over at 5:30 AM IST.
- MSG91 SMS provider implemented (**not testable offline - verify with a real SMS before launch**). Without SMS in production, OTP returns a clean 503 instead of silently printing codes to logs.

## Security / ops
- Production boot guard: refuses `CORS_ORIGINS=*`, placeholder/short JWT secret, demo seeding, demo password, demo UPI ID, incomplete MSG91 config.
- `npm run seed` refuses to run in production (it TRUNCATES every table incl. users).
- `npm run create-admin` creates your first real admin safely.
- JWT pinned to HS256; OTP/order codes use crypto RNG; emails normalised to lowercase; `/health` checks the database.
- Repo: removed 4 stray empty files and tracked `apps/mobile/.env`; stronger `.gitignore`; GitHub Actions CI (typecheck, unit, migrate, seed, acceptance, regression).
