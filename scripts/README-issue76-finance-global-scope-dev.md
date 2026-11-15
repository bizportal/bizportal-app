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

## HTTP selection contract

After the existing genuine signed Super Admin OTP, an explicitly allowlisted global user may request:

`POST /api/mkt/admin/finance-company-selection` with `Content-Type: application/json` and body `{"companyId":1}`.

Server checks the signed session, current user/role/active status in DB, global identity, both allowlists, and active company in DB. A successful selection persists a Finance-specific audit event before it issues a separate Secure, HttpOnly, SameSite=Strict, 30-minute HMAC-signed scope cookie bound to the original session account/email/issuedAt. Any failed audit leaves the user without a new scope cookie.

For every canonical Finance request, a global account must still pass current Super Admin authorization, both allowlists, the cookie's signature/session binding, and an active-company lookup. Frontend localStorage, query parameters, and `x-company-id` never grant Finance scope. Existing company-bound Super Admin behavior remains unchanged. No company-wide consolidated scope is accepted.

## Remaining release gates

- Implement deliberate selection UX and verify real same-origin browser login; the API contract alone is not a UI cutover.
- Genuine Admin mailbox OTP E2E; confirm company 1 positive and company 3 negative using real database and isolated HTTPS browser.
- Fresh, valid DEV PO → delivered shipment → passed goods receipt → Vendor Invoice → 3-way → AP waiting_payment → draft Accounting handoff, with no GL posting or payment.
- Accounting/QRIS/Payroll/HRD behavior parity and full source/API rollback rehearsal.
- Require separate approval for enabling feature flags, merging this candidate, or cutover. Keep PROD untouched.
