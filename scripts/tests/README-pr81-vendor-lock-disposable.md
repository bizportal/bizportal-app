# PR81 — Vendor Invoice restricted-row-lock negative E2E (disposable only)

This gate deliberately does **not** attempt to activate Finance Writer, change CST-DEV privileges, or release to PROD. It captures a known fail-closed result of the **actual unmodified** `createMarketplaceVendorInvoice` service and separates it from the already-PASS matched Invoice → AP → Accounting Draft flow.

## Verified scope

- Source: Draft PR #81 commit `228dc84d3f384979e853b64d3ed37997f69e99d9`, `artifacts/api-server/src/lib/services/mktVendorInvoiceService.ts`.
- Caller: vendor token upload route invokes the service inside `withMarketplaceFinanceDevTransaction(companyId,...)`, which is restricted to a dedicated Finance login.
- PostgreSQL 16 runs in an internal Docker bridge with no published ports or mounted host DB, no Supabase/GCP credentials, no external calls, and no user invoice upload.
- Canonical Drizzle table column layouts are used for PO, Goods Receipt and Vendor Invoice. Test role has SELECT, tenant RLS, and **no UPDATE** on PO or Goods Receipt.
- Test one: actual service fails with PostgreSQL `42501` **at PO** `SELECT FOR UPDATE`.
- Test two: granting a single UPDATE column and scoped RLS **on the disposable PO only** (to isolate the next stage) makes the actual service proceed to the **Goods Receipt** `SELECT FOR UPDATE`, where it fails with `42501`. That temporary grant is **not** a recommendation for live deployment.
- Assert no invoice inserted; outer transaction intentionally aborts. Check that temporary test role, tables and data disappeared. Containers/network are removed even on failure.
- Dependency installation, build and runner never copy a live Finance secret or use the privileged BizPortal shared DB. The activity and notification functions are test-only stubs.

Run:
```bash
node scripts/tests/pr81-build-vendor-lock.cjs
bash scripts/tests/pr81-run-vendor-lock.sh
```

## Interpretation and release gate

This establishes the **permission failure**, not a safe fix to enable vendor uploads. It does **not** replicate all CST-DEV RLS policies/FK triggers, or prove a successful authorized vendor invoice upload. It does not invalidate existing AP/Accounting tests from matched invoices.

**Do not remove PO/GR row locks simply to get green CI**: a plain SELECT or advisory lock alone is not a guaranteed replacement against unrelated PO/GR writers. Do not route the vendor endpoint through a broad privileged pool.

Options needing separate design/security review before implementation include an explicitly verified, tenant-scoped row-locking database routine or a narrowly scoped database policy/permission decision that does not allow unauthorized PO/GR state changes. Any change to CST-DEV schema/role or to canonical service code requires a separate review and targeted concurrency/tenant/idempotency tests. Keep vendor-token upload, Writer, Handoff OFF in shared preview until independently approved HTTP+real DB proof. Keep PR #81 Draft; do not touch PROD.
