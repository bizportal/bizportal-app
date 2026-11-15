# PR #50 — Finance DEV credential source and cutover gate

The canonical Marketplace Finance services use a dedicated, RLS-limited
PostgreSQL connection on CST-DEV. Do not reuse the shared BizPortal
`postgres` connection, the historical Marketplace reader credential, or
any PROD database account.

## Supported sources (choose exactly one)

- **GCP Secret Manager (preferred):** Set
  `BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=bizportal-marketplace-finance-dev`
  on the isolated DEV candidate. The existing BizPortal
  `readSecret(...)` helper accesses this dedicated GCP secret using
  `GCP_SECRET_MANAGER_BOOTSTRAP_JSON` in the server environment. Its payload
  must be the raw, full PostgreSQL URL for the dedicated
  `bizportal_marketplace_finance_login_dev` role on CST-DEV.
- **Protected server environment:** Set only
  `BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV` with the same dedicated
  Finance database URL. Never commit a `.env` or log that URL.

Both sources must not be configured simultaneously. The Finance URL must
identify Supabase **CST-DEV**, authenticate as the dedicated Finance role,
and explicitly require CA and hostname verification using
sslmode=verify-full with sslrootcert=/absolute/path/to/cst-dev-supabase-ca.crt.
The CA must be the genuine project-specific certificate downloaded from the
CST-DEV Supabase Dashboard (Database > Settings > SSL Configuration),
installed securely on the real DEV host. Do not trust a certificate copied
only from an unverified TLS connection or disable rejectUnauthorized.
sslmode=require, verify-ca, a missing CA, and relative CA paths now fail
closed. Node-postgres v8 currently aliases require to verify-full, but
pg-connection-string explicitly warns this becomes weaker in v3.
No CA file has been installed in active Hostinger by this source change.
Any missing, conflicting, wrong-role, PROD, or invalid configuration fails
closed. Generic application-wide secrets are explicitly rejected.

The GCP bootstrap identity is **not currently installed in the active legacy
DEV service**. Secret creation, restricted IAM access, database password
provisioning, and the single direct TLS login must occur through the
authorized secret-management channel. Never request or post passwords,
service-account JSON, or full DSNs in ChatGPT, GitHub comments or PR logs.

The Finance URL is cached only within the isolated server's process; a
dedicated GCP secret read is cached for at most 60 seconds. If the URL changes
while the DB pool exists, Finance fails closed and requires a controlled
service restart. No fallback to `SUPABASE_DATABASE_URL_DEV` or
`SUPABASE_DATABASE_URL` is permitted.

## Strict activation sequence

1. Confirm installed 18 Finance RLS policies and all database owner/role
   guards remain PASS. Keep existing DEV and PROD services unchanged.
2. Install the dedicated credential in GCP Secret Manager with minimum
   Secret Accessor permissions for the intended isolated server identity.
   Confirm the server has the existing GCP bootstrap credentials.
3. From an isolated **DEV-only** candidate, perform a single, direct,
   TLS-protected read-only login with the Finance role. Verify
   `current_user`, `session_user`, and `row_security_active` against
   CST-DEV. Do not run this test through the privileged connection's
   `SET ROLE` shortcut.
4. Verify signed Super Admin OTP, trusted company binding and negative
   cross-tenant requests. Feature flags remain OFF on the live service.
5. Only then exercise the existing canonical Vendor Invoice → 3-way match
   → AP → **draft-only** Accounting handoff with authorized DEV fixtures,
   including idempotency and rollback. No GL posting or actual payments.
6. Require authenticated PDF and Accounting/QRIS parity gates and the
   whole-service rollback rehearsal before proposing DEV cutover.

The existing `scripts/sql/20261115_marketplace_finance_dev_rollback.sql`
provides a guarded rollback of the dedicated Finance role and 18 policies.
It must never be run while the Finance role has active connections, and
must never run on PROD.
