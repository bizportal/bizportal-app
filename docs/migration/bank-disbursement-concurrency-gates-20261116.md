# Bank Disbursement single-writer concurrency gate — 2026-11-16

PR #95 migration audit. Historical implementation inspected in `Travelintrips/CST-BIZPORTAL/.upstream-cst-super-app/artifacts/api-server/src/routes/bankDisbursements.ts`.

## Observed source behavior (not a passing test)

- Upstream POST `/` builds invoice payments in `invoicePayments`; the vendor branch checks `vendor_invoices.grand_total - vendor_invoices.amount_paid` before accepting a payment (near archived lines 1270–1305), and the item branch repeats that reliance (near lines 1740–1783).
- Upstream purchase-document supplier-payment branch sums posted `bank_disbursement_items` and rejects when fully paid (near lines 1709–1748).
- **Further inspection confirmed existing atomic safeguards:** upstream POST wraps journal posting, disbursement header/items and invoice updates inside `db.transaction(async tx => ...)`, calls `postEntryWithClient(tx, ...)`, and conditionally updates `vendor_invoices.amount_paid` with `AND COALESCE(amount_paid,0) + paidAmount <= grand_total + 0.01 RETURNING id` (near archived lines 2058–2155). A failed conditional update throws and rolls back the surrounding transaction. This materially reduces overpayment race risk on that item path. It still does not prove exact replay/idempotency, correct invoicePayment mode convergence, or canonical reconciled allocation custody; those require disposable E2E.
- The canonical `purchase-workflow.ts` source derives vendor amounts from active reconciled allocations. Any bank writer must reconcile the authoritative custody source before debiting bank; the historical denormalized `amount_paid` cannot be trusted by itself.
- Archived `artifacts/api-server/tests/bank-disbursement-phase1.test.mjs` contains T01–T10 (without/with WHT, VOID, negative tax/PO checks, full-payment guard), but invokes real HTTP POSTs with hard-coded journal/accounts/PO IDs. It is **not safe to run against live CST-DEV or PROD**.
- Archived `scripts/verify-bank-disbursement-phase1.mjs` additionally inserts an authenticated session and posts transactions; it must not run against a connected database.

## Required disposable PostgreSQL E2E gates

1. **Isolation**: temporary database with independently generated company A and company B, suppliers, posted invoice, bank journal and COA; no network connection to CST-DEV or PROD.
2. **Atomicity**: one payment creates exactly one bank disbursement, one balanced accounting entry, expected entry lines, and one linked allocation; all within a single commit boundary.
3. **Exact replay**: same logical/idempotency key returns the same committed outcome, never a second bank debit or matching entry.
4. **Concurrent duplicate**: two simultaneous requests to pay the same outstanding invoice cannot both commit payment in excess of invoice outstanding; demand unique key or row/advisory lock applied before balance check and write.
5. **Company ownership**: company A actor cannot pay B's invoice, reuse another company's bank journal/COA, or link items to B's invoice.
6. **WHT**: gross = bank net + withheld amount; withheld amount must link to correct company-scoped liability, not expense; journal balances match.
7. **Reversal/void**: original disbursement may only be voided according to one writer's state machine, and reversal journal is idempotent. Invoice balance and allocations must converge; no orphan active payment.
8. **Failure rollback**: intentionally fail after inserting header but before posting journal; transaction must roll back all entries and allocations.
9. **Provenance**: every created journal has a stable source and company scope; audit log records actor and operation once.
10. **No side effects on GET**: list/detail/outstanding endpoints never write, open a transaction for payment, or call posting helpers.

## Deployment / migration posture

The candidate's DEV-only read adapters are flag-OFF by default, and `reviewOnly` results must never authorize writes. Current active DEV route does not have the upstream sole-executor registered. Do not activate the upstream source writer or cut over until a canonical single-writer service and its exact dependency graph are verified against the above gates. Use a disposable database; no direct manipulation of live payment invoices, bank disbursements, or journals.

**No writer code or database mutation is introduced by this audit.**
