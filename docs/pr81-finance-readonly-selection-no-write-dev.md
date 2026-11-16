# PR #81 — Finance GET-only company selection, without business writes

This small change reuses existing Draft PR #81's signed Super Admin company
scope and canonical Vendor Invoice/AP **GET** routes. It **does not** add a
second Finance API, new login, extra database role or alternate Finance
credential.

## Two distinct modes

When `BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV=true` and
`BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV` is **OFF**:

- `POST /api/mkt/admin/finance-company-selection` still validates the
  current signed Super Admin session, explicit company allowlist, same-origin
  request, active company and exact JSON shape.
- It writes **no** `public.audit_logs` row, because the dedicated Admin auth
  role has no such Finance audit INSERT policy. It emits a structured
  application-log event with the verified actor ID and company ID, then
  issues the existing signed HttpOnly + Secure company cookie.
- Canonical Vendor Invoice/AP GET handlers then execute via
  `withMarketplaceFinanceDevReadOnlyTransaction`, which executes
  `SET TRANSACTION READ ONLY` **before any SELECT** and verifies the
  dedicated Finance role and RLS.
- Every canonical Finance POST/mutation route remains **404** unless the
  separate Writer flag is explicitly enabled.
- Direct calls into `withMarketplaceFinanceDevTransaction` with the writer
  flag OFF now reject before opening or reusing a Finance connection. A
  previously initialized pool is not a right to write.

When the **Writer** flag is ON, the existing company-selection database audit
INSERT remains mandatory and fails closed if it cannot be persisted. The
original Vendor Invoice/AP mutation controls are unchanged.

## Verification and known limitation

Targeted runtime tests cover read-only selection without DB audit, writer
audit preservation, explicit writer-helper denial, signed company cookie,
tenant RLS, and OTP/Finance integrations.

The live CST-DEV Finance principal has 18 RLS policies; direct role-authenticated
`BEGIN READ ONLY` checks for unbound / company 1 / company 3 were previously
verified. The historical 10 vendor invoices have no canonical Marketplace PO
binding, so they remain invisible by design to these canonical GET routes.
Do not modify historical data or relax RLS for test convenience.

**Deployment remains OFF:** this is source-only, not enabled on current DEV
preview and never touches PROD. Before private preview activation: install
approved Finance-only secret/reader; keep Writer/Accounting/Payment flags OFF;
allowlist only GET canonical Invoice/AP and signed selection POST in Nginx;
verify authenticated company 1 vs 3 with a correctly linked, authorized DEV
fixture and rollback. Do not copy the Super Admin password or shared postgres
credential into Finance.
