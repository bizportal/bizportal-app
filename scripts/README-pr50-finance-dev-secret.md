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

### Existing private DEV systemd bootstrap (no secret copying)

The isolated DEV preview already mounts the service-account JSON as the
**systemd credential file** `gcp-secret-manager-bootstrap.json`. The canonical
`readSecret` helper can now read that mounted credential **without exporting
the secret contents as an environment variable**, only when all of these hold:

- `APP_ENV=development` (even if the Node bundle uses `NODE_ENV=production`);
- `BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED=true` is explicitly set;
- `CREDENTIALS_DIRECTORY` is an absolute directory assigned by systemd;
- the fixed credential filename is a regular nonempty file at most 16 KiB.

When a direct `GCP_SECRET_MANAGER_BOOTSTRAP_JSON` is already provided, its
original behavior takes precedence. In actual PROD, missing direct bootstrap
is still rejected regardless of any systemd flag. The contents, file path,
access token, dedicated Finance URL and private key are never logged.

This **does not activate Finance Writer** or grant database privileges. An
isolated DEV service must independently obtain approved dedicated Finance
credentials, pass the official TLS/RLS read-only probe, verify signed Super
Admin company binding and pass the staged tenant lock/rollback gates first.

Both sources must not be configured simultaneously. The Finance URL must
identify Supabase **CST-DEV**, authenticate as the dedicated Finance role,
and include TLS (`sslmode=require`, `verify-ca`, or `verify-full`).
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
   TLS-protected read-only login with the Finance role. Use the checked-in
   `scripts/dev-finance-direct-readonly-probe.sh` (separate process, not
   the active service) after installing the secret and approved GCP IAM.
   For example, with a shell whose authorized GCP bootstrap is already
   configured, execute:

   ```bash
   APP_ENV=development \
   PR50_FINANCE_READONLY_PROBE=true \
   BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true \
   BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=bizportal-marketplace-finance-dev \
   bash scripts/dev-finance-direct-readonly-probe.sh
   ```

   The tool verifies `current_user`, `session_user`, real TLS from
   `pg_stat_ssl`, `row_security_active` on 11 Finance tables and
   read-only tenant-1/tenant-3 probes. Missing credentials and an unbound
   company fail closed, with no financial writes or secret output.
   A successful direct probe prints `FINANCE_DIRECT_TLS_RLS_READONLY_PASS=true`.
   The script temporarily compiles into the existing `lib/db` workspace,
   then removes its compilation artifact. It **does not** use privileged
   `SET ROLE` and never enables the active service.
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
