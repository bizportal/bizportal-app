# PR #81 — CST-DEV signed Finance summary (read-only only)

This is a **separate, opt-in source candidate**, not an activation of the
existing Vendor Invoice/AP writer. It reuses the existing signed Super Admin
application session, dedicated Finance principal and RLS policies.

## Explicit DEV-only runtime gates

All of these must be deliberate. Unset = HTTP 404 on the entire new route tree.

- `APP_ENV=development`
- `BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV=true` (existing password login)
- `BIZPORTAL_SIGNED_OTP_ENABLED_DEV=false`
- `BIZPORTAL_FINANCE_READONLY_ENABLED_DEV=true`
- `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=false` **must stay OFF**
- `BIZPORTAL_FINANCE_READONLY_SUPERADMIN_EMAIL_DEV=<approved exact email>`
- `BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV=<same existing account email>`
- `BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV=1,3`
- `BIZPORTAL_FINANCE_READONLY_ORIGIN_DEV=https://finance-pr81.72.61.210.205.sslip.io`
- Existing dedicated Finance credential via **one** of `BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV` or `BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=bizportal-marketplace-finance-dev`. Do not use the generic application DB role for Finance.
- Existing independent `SESSION_SECRET` or `BIZPORTAL_SESSION_SECRET`, at least 32 characters.

Do not place any Finance DSN, DB password, signing secret or Super Admin
application password in GitHub, logs, commands, browser URLs or chat.

## Restricted API only

1. `POST /api/mkt/admin/finance-readonly/select-company` with JSON
   `{"companyId":1}` or `{"companyId":3}` after a signed Super Admin login.
   Requires origin, Host and forwarded HTTPS identity to match the configured
   preview URL and `Sec-Fetch-Site: same-origin`. Requires an active company
   from the existing restricted app DB. Issues a 30-minute, session-bound,
   HMAC-signed, HttpOnly, Secure, SameSite=Strict **read-only scope cookie**.
   No business or audit table write is performed.
2. `GET /api/mkt/admin/finance-readonly/summary` requires the same current
   signed Admin session and scope cookie. It creates a fresh pool to the
   existing restricted Finance role, verifies TLS, role, all 11 RLS tables,
   starts `BEGIN READ ONLY`, sets `app.marketplace_company_id` transaction
   locally, performs only four aggregate SELECTs through RLS, always rolls
   back and closes the pool.
3. No POST for Vendor Invoice/AP/payment/GL, no Finance Writer feature flag,
   no `UPDATE`, no `INSERT`, and no ERP workflow changes.

**Important:** The Finance database role has limited DML grants by design for
the *separate* canonical AP workflow. The read-only route forces the transaction
access mode to READ ONLY; the existing Finance Writer routes still fail closed
when `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=false`.

## Before exposing on the private VPS preview

- Current Draft PR #81 code and latest exact HEAD CI must be reviewed and pass.
- The credential delivery path (Finance GCP secret reader or approved private
  service credentials) must be available only to the intended restricted
  DEV process. No privileged `postgres` or Finance/Admin password reuse.
- Add Nginx exact allowlist for **only** `/api/mkt/admin/finance-readonly/select-company`
  (POST rate-limited) and `/api/mkt/admin/finance-readonly/summary` (GET),
  stripping proxy Authorization and preserving no-store, TLS and the general
  404 denylist for all other API paths.
- Verify anonymous, wrong-user, wrong-company, expired cookie, tampered cookie,
  CSRF, wrong Host, missing scope and reversed company selection all denied.
- Verify 1 → 3 independent tenant scoped SELECT and teardown, but understand
  historical vendor invoices with `mkt_purchase_order_id IS NULL` are
  **correctly invisible** to the existing Finance RLS. Do not loosen RLS or
  relink historical invoices to make the test pass.
- Positive canonical invoice → PO → goods receipt → AP path requires a new
  authorized **DEV-only** fixture, with explicit rollback. No PROD writes.
- Keep Draft PR #81, payments, GL posting, Finance Writer, and Accounting
  handoff unchanged until independently approved.

## Test evidence (source only)

- `dev-finance-readonly-db.test.ts`: transaction mode, cleanup, strict TLS,
  DB role/RLS guard, tenant 1/3, no writer fallback.
- `dev-finance-readonly-summary.test.ts`: signed company selection, cookies,
  session revocation, CSRF/Origin, wrong company, missing auth, disabled writer
  routes and generic failure handling.
- Existing PR #81 Finance/OTP/signed-password regressions must remain PASS.
