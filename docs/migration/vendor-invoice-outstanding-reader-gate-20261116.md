# Outstanding Vendor Invoice reader parity gate — 2026-11-16

Repository: `bizportal/bizportal-app` PR #95 (draft). Database evidence: Supabase CST-DEV only, read-only queries.

## Existing frontend contract

`artifacts/bizportal/src/pages/accounting/bank-disbursements.tsx` requests `GET /api/accounting/bank-disbursements/vendor-invoices/outstanding?company=N`.

The legacy upstream implementation returns `apAccountId`, `apAccountName`, `invoices` (including document identity, supplier, currency, withholding, expense allocation and outstanding amounts), and `suppliers`.

## Unsafe semantic mismatch

The upstream archived executor's outstanding selector uses `vendor_invoices.amount_paid` and `purchase_documents.amount_paid` (denormalized amounts) for outstanding filtering, optionally including `settled_unlinked` variants. The canonical `purchase-workflow.ts` invoice detail and list instead use reconciled active payment allocations as `reconciled_amount_paid` and set `amountPaid` from that source. Copying the old SQL unchanged risks displaying a different payable balance from canonical Vendor Invoice/AP.

Legacy `vendor-invoices/outstanding` also mingles invoice presentation with payment execution flows and reconciliation mutation-specific options. Reuse neither the denormalized payment balance nor implicit eligibility for a new writer.

## CST-DEV read-only evidence

- Tables and relevant columns exist: `vendor_invoices`, `purchase_documents`, `accounting_settings`, `payment_allocations`, `payment_matching_groups` and `bank_reconciliation_matches`.
- Observed rows: 10 vendor invoices and 3 purchase documents. The canonical reconciled allocation scan in this audit returned 0 positive reconciled vendor-invoice payment records.
- Observed bank-disbursement rows: 1 header and 1 item for company 1, recorded status `posted`. This is historical data, **not** a disposable test transaction.
- These observations do not establish E2E proof for reversal, duplicate settlement, or WHT.

## Required next step before implementing GET outstanding

1. Define one shared accounting payment-balance reader matching the canonical active-allocation CTE; enforce `company_id` on each join and ensure the ID namespace distinguishes purchase document versus vendor invoice.
2. Define read-only results separately from `canPay`. Filter out or flag unresolved reversal/orphan/void evidence. Never offer an automatic bank payment action solely from an outstanding balance.
3. Confirm DB schema and equality of derived paid balances against the existing Vendor Invoice API, including partial/voided/unknown states and taxes.
4. Add disposable PostgreSQL and HTTP tests for two companies, partial allocation, replay, reversed/orphan disbursement, and negative results; no PROD or active DEV payment mutation.
5. Retain the sole executor writer blocker and the default-off read adapter flag until all gates PASS.

**No outstanding-invoice route has been added by this note.** This documents why a direct legacy copy would be unsafe; it authorizes no cutover.
