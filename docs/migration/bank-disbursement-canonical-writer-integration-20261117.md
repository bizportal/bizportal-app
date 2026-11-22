# PR #95: canonical Bank Disbursement writer integration checklist (2026-11-17)

**Runtime status: BLOCKED / writer OFF.** This document records a source-verified, minimal integration path, not a request to transplant the historical 2,557-line writer.

## Repository inventory

- Existing Accounting schema: `lib/db/src/schema/accounting.ts` defines `accounting_journals`, `accounting_entries`, `accounting_entry_lines`, COA, and settings.
- Vendor Invoice schema: `lib/db/src/schema/purchaseWorkflow.ts` defines `vendor_invoices` and `payment_requests`; a Marketplace Accounting handoff creates a **draft payment request**, never settles a payment.
- Existing HTTP `artifacts/api-server/src/routes/accounting.ts` has GET entries and DEV-gated Bank Disbursement list/detail/outstanding readers; no POST Bank Disbursement writer.
- Historical sole executor: `Travelintrips/CST-BIZPORTAL/.upstream-cst-super-app/artifacts/api-server/src/routes/bankDisbursements.ts`. The `direct` branch already uses `db.transaction` + `postEntryWithClient`; the `vendor_invoice` branch uses `postEntry` plus independent DB writes and must **not** be copied as-is.
- Candidate boundary `artifacts/api-server/src/lib/bankDisbursementAtomicBoundary.ts` is **not imported/registered by a production route**. Its PostgreSQL/CI tests verify transactional behavior of test adapters, not genuine bank writer custody.

## Exact mandatory integration sequence, all in one transaction

1. Authenticate verified Super Admin and company context; don't grant access using an unverified `?company` request.
2. Check payment request approval/custody and vendor invoice's three-way-match status, supplier, currency, company, cancellation and tax-review state.
3. Acquire transaction-scoped company/idempotency-key lock, then invoice `FOR UPDATE`; use the same lock order on every writer path.
4. Read canonical active, final/reconciled `public.payment_allocations` for the **same company/invoice**. The historic `vendor_invoices.amount_paid` is denormalized and is not independently authoritative.
5. Exact replay only when company, invoice, amount and WHT match a **fully persisted** (journal + disbursement + allocation) receipt; a mismatched replay is a conflict.
6. Validate bank journal, COA tenant scope, AP liability, WHT liability, and gross/net journal balancing. Integrate **the existing canonical ledger poster**, not a second ad hoc journal generator. Journal number generation must be concurrency-safe (not `count(*)+1`).
7. Within the same DB transaction, post `accounting_entries` and `accounting_entry_lines`, write disbursement header/items, create the canonical reconciled allocation/binding, and update invoice payment status.
8. Failure at any stage (including allocation update) rolls back **all** rows; no fire-and-forget reconciliation/tax callbacks may be prerequisite to payment correctness.
9. Reuse existing reversing/void custody and tax policies; reversal must not generate duplicated bank credit or orphan accounting lines.
10. On disposable PostgreSQL, execute **real HTTP route + real production service adapters**, verifying replay, changed-payload conflicts, concurrent same/different invoice keys, company crossover, WHT, failure injection, reversal, and company-scoped ledger provenance.

## What remains unavailable

The canonical repository currently lacks a complete registered Bank Disbursement POST sole executor with verified actual journal-poster, reconciled-payment writer, and reversal custody in one transaction. The unregistered candidate provides *only orchestration*; the test adapters use temporary journal tables and must not be mistaken for live accounting integrations.

**Merge/cutover decision:** continue holding PR #95 Draft and Bank Disbursement flags OFF until actual canonical writer integration is demonstrated on disposable PG and all Release Gate/Payroll gates are PASS. No PROD or active DEV write is required for these tests.
