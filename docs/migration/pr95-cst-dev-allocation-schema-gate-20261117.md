# PR #95 — direct CST-DEV payment custody schema audit (2026-11-17)

**Evidence:** read-only `information_schema` / FK metadata and aggregate counts from Supabase CST-DEV project `xssrfshdrtdfupgqwfdw`. No real rows were created, modified or voided; PROD untouched.

## Verified database facts

1. `public.payment_allocations` has `invoice_id`, `company_id`, `group_id`, `allocated_amount`, `is_active`, `payment_id`, **`mutation_id NOT NULL`**, and an FK `mutation_id -> public.bank_mutations(id)`. Its current schema has **no `vendor_invoice_id`, `disbursement_id`, or free-standing allocation `status` column**. Any status expression comes from matching group or bank mutation, not `pa.status`.
2. `public.bank_disbursement_items` has optional `vendor_invoice_id` and mandatory `disbursement_id`; `public.bank_disbursements` has `entry_id` (FK to `public.accounting_entries`), `journal_id` (FK to `public.accounting_journals`), and `status`. There is no native `payment_allocations -> bank_disbursements` relationship in the inspected FK metadata.
3. Read-only CST-DEV counts at inspection: `payment_allocations=0`; `active_allocations=0`; `vendor_invoices: 8 draft, 2 posted`; `bank_disbursements: 1 posted`; `bank_disbursement_items with vendor_invoice_id: 1`. **This does not prove an outstanding amount or an erroneous payment; the canonical allocation reader currently has no allocation evidence.** Do not equate denormalized `vendor_invoices.amount_paid` with finalized reconciliation.
4. Existing canonical `purchase-workflow.ts` and DEV-only Bank Disbursement outstanding reader use the same reconciled-allocation CTE, guarded by active allocations and final/reconciled matching group or bank mutation status. Their source parity tests previously passed.
5. Synthetic `pr95_real.allocations` in `bankDisbursementAtomicBoundary.postgres.test.ts` is a test-owned facsimile with `disbursement_id`, `gross_minor`, `status`, `is_active`. It is **not** a schema-compatible adapter for `public.payment_allocations`, nor a real bank mutation reconciliation flow. Its HTTP and PostgreSQL tests verify only the generic transaction boundary.

## Concrete operational implication

The next integration cannot write `public.payment_allocations` merely from a Vendor Invoice and Bank Disbursement: `mutation_id` is mandatory. A genuine bank mutation must already exist, be company scoped and pass the canonical reconciliation lifecycle before recording a final matching allocation. Where no bank mutation exists, a Bank Disbursement posting and its source/accounting payment evidence must remain distinguishable from a *bank-reconciled* allocation. Do not fabricate bank mutations, backfill `payment_allocations`, or alter existing posted rows as a workaround.

**Required E2E sequence before enabling payment:**

- Identify and reuse the authorized sole payment writer and canonical ledger poster (not the archived non-atomic `vendor_invoice` branch).
- Verify the source payment request/AP approval/tenant/supplier/COA and journal provenance, WHT gross/net, and atomic journal + bank disbursement + source payment state changes on disposable PostgreSQL.
- Verify that `GET Vendor Invoice outstanding` and journal evidence distinguish paid vs *reconciled*, and do not falsely mark an invoice paid from an unrelated `payment_allocations.invoice_id` coincidence.
- Once a genuine bank mutation is available, exercise existing matching/reconciliation service in a separate permitted lifecycle with company-scoped source evidence and idempotency. No duplicate posting.
- Verify replay, cancellation/reversal, and orphan/cross-company cases; production gating remains OFF until those paths PASS on real services.

**Decision:** PR #95 remains Draft. Leave the synthetic test untouched for its existing valid contract coverage; its PASS is not a deployment permission. No application-runtime or database write was performed in this audit.


## Existing canonical mutation writer found — 2026-11-17 follow-up

Source audit of `artifacts/api-server/src/routes/bank-reconciliation.ts` found the **already registered** endpoint `POST /bank-reconciliation/:mutationId/vendor-invoice-payment-batch` (near line 8331). Within one `client.query("begin") ... commit/rollback` transaction, this writer creates `accounting_entries`, `accounting_entry_lines`, a `payment_matching_groups` row, `payment_allocations` rows with a **real mutationId**, reconciliation matches, and bank mutation approval state. It uses `getApprovalActor(req)`; it is not a Bank Disbursement POST endpoint. The canonical bank-reconciliation posting transition is separate from the batch approval's `approved_pending_posting` state. Its capabilities are *code-verified, not fresh HTTP E2E verified in this audit*.

**Important correction to earlier generalized claims:** The repository **does have a canonical Vendor Invoice bank-mutation matching/allocation writer**, so do not create another one, reuse it. The *missing piece* remains an authenticated Bank Disbursement sole-executor for payment initiation/settlement with its own source custody, plus a well-defined handoff to bank-mutation reconciliation which must **not post the same bank debit twice**. Source contract test `src/__tests__/pr95-existing-vendor-bank-reconciliation-writer.test.ts` freezes the existing route and its transaction boundary. No database mutation or activation has occurred.

### Integration decision

- Preserve the existing bank mutation vendor invoice batch endpoint as-is.
- Keep the PR95 candidate's `pr95_real.allocations` synthetic table limited to testing its generic transaction contract; it is not a drop-in integration with `public.payment_allocations`.
- Before creating a Bank Disbursement writer, map whether a payment initiation creates an accounting journal that bank reconciliation should *match* rather than *repost*, including transition from `approved_pending_posting`, and prove both paths cannot debit bank for the same settlement.
- Cutover remains BLOCKED until real service E2E establishes payment-source custody, company scope, no double journal, no fabricated bank mutation and correct reconciliation state.
