# PR117 — Canonical Vendor Invoice through Accounting with real PR108 session-bound locks

**Draft / source and disposable CI only. Do not deploy or install review-only SQL on CST-DEV or PROD.**

## Why

Earlier PR100 demonstrated canonical AP and Accounting against disposable PostgreSQL, while PR108 tested a session-user-bound private PO→GR→Shipment lock function with synthetic company logins. Neither independently proved that **the unchanged canonical Vendor Invoice service actually works with the narrow Finance privileges and the PR108 lock function in one transaction**.

PR117's first real combined PG16 test found a genuine defect: Drizzle's generic `.insert(vendorInvoicesTable).values(...)` and invoice-line insert enumerate **every column with DEFAULT**, including columns for which the dedicated Finance role does not have INSERT privilege. PostgreSQL rejected it with SQLSTATE **42501**. The service fix replaces only those two INSERT operations with parameterized SQL naming exactly the **20 already approved header fields** and **9 approved invoice-line fields**; it does not add permissions, change RLS, create a second writer, change any existing business validation, or bypass 3-way matching.

## Data isolation

- Uses **only** `postgres:16-alpine` or `postgres:17-alpine` plus `node:22-alpine` on a disposable `docker network create --internal` network, with no published ports or live DB credentials.
- Fixed synthetic database `cst_pr107_ci`, synthetic login/passwords; the service DB stub rejects any other host, database, role or password.
- Original PR107/108 installation and rollback files remain guarded and unexecutable as checked in. The harness verifies that both source guards raise errors; only *in-memory copies* with the fixed guard removed execute inside the disposable container.
- Creates an 11-table/18-policy **synthetic baseline** matching key Drizzle fields, adds the remaining canonical Drizzle columns in the disposable fixture, and creates company-specific LOGIN credentials only inside the disposable database. This is **not** full CST-DEV schema parity.
- The canonical Vendor Invoice, 3-way-match, AP, and Accounting service functions execute as a real authenticated synthetic CST company database login. The PR108 function uses `session_user`, not the editable tenant setting, to authorize row locks.
- Main business writes occur in a transaction intentionally **rolled back**. Real audit/notification publishers are stubbed to fail if run and the deferred callbacks are not executed. No real Storage upload, bank transfer, payment, WhatsApp, journal, or PROD action occurs.
- The original PR108 then PR107 guarded rollbacks are executed (in-memory unguarded copies in the disposable DB only), restoring the original 18 synthetic policies with no company login roles or private schema; Docker containers/network removed via trap.

## Positive and negative checks

The real service runs with two PO lines and two accepted GR item rows:
1. Synthetic CST login cannot read/lock Diva when its tenant GUC is set to Diva.
2. Wrong 64-hex vendor token cannot lock an otherwise valid CST PO.
3. Real Vendor Invoice service writes one two-line `draft` invoice using only reviewed column privileges; replay produces the same ID, no second invoice.
4. Real 3-way match validates PO price, received quantity, currency and total; reaches `ready_for_ap`, replay remains idempotent.
5. Real AP creation and replay, `finance_review` then `waiting_payment`.
6. Real Accounting creates **one** `draft` Payment Request and `draft_not_posted` handoff; replay preserves IDs.
7. Finance login has no INSERT privilege on test GL table; no notification publisher is executed.
8. Business transaction rollback leaves no new invoice; staged role/owner/function rollback removes all temporary policies and preserves the 18-policy baseline.

## Testing

```bash
node scripts/tests/pr117-build-vendor-service.cjs
PR117_DISPOSABLE_PG_IMAGE=postgres:16-alpine bash scripts/tests/pr117-run-real-vendor-finance-pg16.sh
# GitHub CI repeats the exact test on PostgreSQL 16 and 17.
pnpm --dir artifacts/api-server exec vitest run \
  src/routes/mktVendorInvoice.dev-compat.test.ts \
  src/lib/services/mktMarketplaceCompanyScope.test.ts \
  src/routes/dev-marketplace-finance-writer.test.ts \
  src/lib/services/mktAccountingHandoff.test.ts
pnpm --dir artifacts/api-server typecheck
```

**Important:** This integration fixes a real source-permissions defect but does **not** certify live CST-DEV Writer, company-role GCP credential custody, signed Super Admin HTTPS user session, RLS migrations on the actual Supabase project, or the POST-commit audit/Storage delivery lifecycle. PR106–108 must remain Draft/review-only until their separate security/release gates pass. Source-level CI success must not trigger PROD or the live private PR81 preview.
