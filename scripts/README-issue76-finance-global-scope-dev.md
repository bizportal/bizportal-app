# Issue #76 — DEV Super Admin Finance company selection

**Source-only, default OFF. Not a release or Hostinger/PROD cutover.**
This patch reuses the existing signed OTP session and canonical Marketplace Finance routes; it does not replace login, create a second finance writer, or change any PostgreSQL roles/RLS policies.

## Explicit isolated DEV flags

All conditions must be true in the **separate DEV candidate process**:
- `APP_ENV=development`
- `BIZPORTAL_SIGNED_OTP_ENABLED_DEV=true`, plus existing signed session secret
- `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true`, plus the dedicated Finance GCP secret reader
- `BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV=true`
- `BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV` — explicit comma-separated authorized *global* Super Admin emails; no wildcards
- `BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV` — explicit comma-separated positive active company IDs; no wildcards

Do **not** enable these on the active legacy DEV service or PROD. No default account or company ID is assumed.

## Existing BizPortal Vendor Invoice UI (separately gated)

The existing `/purchase/vendor-invoices` page can display an explicit
**Verifikasi Perusahaan Finance (DEV)** panel only when the independent
build-time flag `VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV=true` is set.
It stays hidden by default and does **not** automatically call the Finance API.
The panel uses the currently selected company from `CompanyContext` only as
a selection suggestion; the server verifies the signed OTP, both allowlists,
active company, and writes the audit event. The consolidated/all-company
selection is disabled. Company changes reset local confirmation, and there
is no automatic payment, posting or AP mutation. Errors are displayed
without exposing response bodies or credentials.

The panel is **not** proof of end-to-end browser authentication. It must
be verified on an isolated HTTPS candidate with a genuine authorized
Super Admin OTP before enabling any live Finance feature flags.

## HTTP selection contract

After the existing genuine signed Super Admin OTP, an explicitly allowlisted global user may request:

`POST /api/mkt/admin/finance-company-selection` with `Content-Type: application/json` and body `{"companyId":1}`.

Server checks the signed session, current user/role/active status in DB, global identity, both allowlists, and active company in DB. A successful selection persists a Finance-specific audit event before it issues a separate Secure, HttpOnly, SameSite=Strict, 30-minute HMAC-signed scope cookie bound to the original session account/email/issuedAt. Any failed audit leaves the user without a new scope cookie.

For every canonical Finance request, a global account must still pass current Super Admin authorization, both allowlists, the cookie's signature/session binding, and an active-company lookup. Frontend localStorage, query parameters, and `x-company-id` never grant Finance scope. Existing company-bound Super Admin behavior remains unchanged. No company-wide consolidated scope is accepted.

## Normalized email identity uniqueness gate

Historical Issue #76 finding: CST-DEV previously had two `public.users`
identities sharing a case-insensitive Admin email, with different roles
(`admin` and `super_admin`). The earlier email-only `LIMIT 1` lookup
could select the wrong identity. **A fresh aggregate-only read on
15 Nov 2026** found one active eligible `super_admin` and one disabled
historical identity, **not two simultaneously active identities**.
This source-only review did not change either account. Do not infer
when, how or by whom any account state changed.

In signed DEV OTP mode, the session is pinned to the account ID and email.
The database uniqueness guard refuses **any second `is_active=true`
account** sharing the normalized email regardless of inconsistent status
text or whitespace; the selected account must still pass the existing
TypeScript active-status check. An `is_active=false` historical shadow
does not block the sole active identity. PROD authentication semantics
are unchanged. No identity or role should be modified as part of this
source-review candidate.

Read-only identity audit: the older `super_admin` account has a recorded
recent login and password, while the later `admin` account has no
recorded login or password. Neither has a direct `user_allowed_companies`
assignment or a division-manager foreign-key reference. This is supporting
evidence, **not authorization** to alter either account.

An explicitly approved account review may mark an unintended historical
shadow inactive while preserving its row and audit history. Do not delete,
re-role, silently change company binding, or infer Finance permissions from
account timestamps. No account status was changed as part of this PR.
After any approved identity reconciliation, re-run the live signed OTP
and cross-company Finance checks before any cutover.

## Loopback source/API rollback rehearsal (no credentials)

`scripts/dev-issue76-loopback-rollback-smoke.sh` performs **baseline PR #50
→ PR #77 candidate → baseline** in sequential, short-lived, 127.0.0.1-only
processes using the same isolated port. It deliberately clears all inherited
database, SMTP, GCP and session credentials and disables Finance, OTP and
embedded scheduling. It verifies HTTP 200 for liveness, 401 for anonymous
Admin/company routes, 404 for disabled Finance, and unchanged live systemd
PID, source SHA and Nginx configuration fingerprint.

Initial rehearsal exposed a pre-existing SIGTERM bug: the handler only
cancelled schedulers but did not close the listener. The candidate now
closes the HTTP listener and idle connections and bounds termination to
10 seconds. The script explicitly requires **candidate SIGTERM to exit
gracefully**. The old PR #50 baseline may require forced shutdown; the
test script uses a limited fallback only for those unchanged baseline runs.

A new isolated compiled-API negative HTTP smoke was also run against the
integrated candidate using the PR #77 script: nine liveness, anonymous,
forged-cookie/header and denied Accounting handoff expectations PASS.
No real database, OTP, user identities or money-moving routes were used;
the active VPS service and Nginx SHA remained unchanged.

This is **not** a complete real Admin/DB rollback rehearsal. The existing
live legacy service also has the old SIGTERM behavior, which must be
accounted for in the eventual drain/cutover plan. Do not switch Nginx,
systemd, signed OTP, Finance or PROD based on this smoke alone.

## Actual built API: negative-only authenticated-boundary smoke

The repeatable `scripts/dev-issue76-finance-unauth-http-smoke.sh` launches
the **compiled PR #77 API** only on isolated VPS loopback port `19879`
with a sanitized environment, a fresh ephemeral random test signing key,
only `.invalid` synthetic allowlisted email, and no DB, GCP or SMTP
credentials. OTP, Finance and global-company feature flags are enabled
**only in the temporary process** to exercise the runtime authentication
guards; no sign-in or OTP endpoint is called.

Expected responses:
- `/api/health/live` returns 200.
- Unauthenticated `/api/companies`, Finance Vendor Invoice and AP
  detail endpoints return 401.
- Forged `x-company-id` and forged production session cookie cannot
  authorize Finance: 401.
- Anonymous / forged-cookie Finance company selection POSTs return 401.
- Anonymous Accounting Handoff POST returns 401.

The smoke also checks unchanged active systemd service PID, source SHA,
Nginx SHA-256, and no leftover local listener. It cannot demonstrate
genuine SMTP OTP delivery, valid signed Admin session, live RLS-backed
HTTP response, or successful financial transaction.

## Remaining release gates

- Implement deliberate selection UX and verify real same-origin browser login; the API contract alone is not a UI cutover.
- Genuine Admin mailbox OTP E2E; confirm company 1 positive and company 3 negative using real database and isolated HTTPS browser.
- Fresh, valid DEV PO → delivered shipment → passed goods receipt → Vendor Invoice → 3-way → AP waiting_payment → draft Accounting handoff, with no GL posting or payment.
- Accounting/QRIS/Payroll/HRD behavior parity and full source/API rollback rehearsal.
- Require separate approval for enabling feature flags, merging this candidate, or cutover. Keep PROD untouched.
