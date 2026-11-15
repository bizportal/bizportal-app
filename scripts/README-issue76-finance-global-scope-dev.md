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

CST-DEV currently contains two active `public.users` rows that normalize
to the same Admin email, but have different roles (`admin` and
`super_admin`). Previously, an OTP query using `lower(email)` plus
`LIMIT 1` could select either account. For DEV **signed OTP only**,
both OTP identity lookup and subsequent session authorization now check
up to two **eligible active** accounts (and require exactly one).
Two active accounts fail closed. An inactive historical shadow cannot
silently regain access; changing its status to active immediately makes
the identity ambiguous again. PROD authentication semantics are unchanged.

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

## Remaining release gates

- Implement deliberate selection UX and verify real same-origin browser login; the API contract alone is not a UI cutover.
- Genuine Admin mailbox OTP E2E; confirm company 1 positive and company 3 negative using real database and isolated HTTPS browser.
- Fresh, valid DEV PO → delivered shipment → passed goods receipt → Vendor Invoice → 3-way → AP waiting_payment → draft Accounting handoff, with no GL posting or payment.
- Accounting/QRIS/Payroll/HRD behavior parity and full source/API rollback rehearsal.
- Require separate approval for enabling feature flags, merging this candidate, or cutover. Keep PROD untouched.
