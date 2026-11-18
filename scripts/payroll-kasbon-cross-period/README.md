# Kasbon installment continuation: preserve principal across Payroll periods

## Reproduced defect, not an inferred salary correction

On parent `478659611b908b4a3eee03f35ab718a323675047`, the packaged native
writer/application suite successfully posted one synthetic installment. A
subsequent call to the existing pure `calculateKasbonAutoDeduction` rejected the
actual persisted loan with `KASBON_BALANCE_MISMATCH`.

Synthetic example (not a real employee loan): principal 500,000; installment
100,000. The previous application update stored paid=100,000, settled=100,000,
remaining=400,000. The projector uses the existing additive invariant:

```
principal = cash repayment + noncash settlement + remaining
```

The prior one-period test explicitly expected both totals to rise; that assertion
was wrong for this contract and therefore did not prove continuation into a
second month. The baseline was rerun before the patch, with a real PostgreSQL
post followed by the real projector. Its reproduction line is retained in the
result log; no live loan was touched.

This invariant is also explicit in the pre-existing `routes/cashAdvances.ts`
settle-to-expense implementation: noncash settlement must not increase cash
repayments. The inspected original file SHA256 is
`5dd53c130d4abd26e7dd42b5a839568f35231a59c6c3a770a33978674e8efb44`.
The existing Payroll journal pays no cash; it credits the employee receivable.

## Targeted change, existing journal engine retained

- `assertKasbonPrincipalBalance` shares the existing integer-cent invariant
  between projection and posting. Input money validation is unchanged.
- Payroll accrual increases **settled_amount only**, preserves paid_amount and
  reduces remaining_amount exactly once. The original journal, repayment-ledger
  row, approval receipt, reservation and transaction/idempotency flow are reused.
- UPDATE returns all three persisted totals. They must match the locked prior
  state and requested deduction exactly before the service records a repayment
  and confirms the run. A mismatch aborts the transaction.
- A period already carrying a confirmed deduction is blocked from creating a
  new projection. Replaying an already-posted Payroll request still uses the
  original verification path and never deducts again, even after later months.
- The tested reduced-privilege fixture no longer grants UPDATE(paid_amount), and
  the runtime structural preflight explicitly rejects that extra capability.
  No actual role, permission, membership, credential or policy is modified.
- Historical inconsistent rows are NOT reinterpreted, normalized, silently
  zeroed or bulk-migrated. They remain rejected pending separate reconciliation.

The old application regression expectation was changed from paid=100,000 and
settled=100,000 to paid=0 and settled=100,000. This is the identified defect's
fix, not a relaxation of a test to hide failure. The journal line algorithm and
native artifact are unchanged; normal transaction rollback checks remain.

## Verification scopes

- Seven added pure projection cases cover continuation, prior cash/noncash
  history, historical double counting, same-period confirmation, final fractional
  amount, year change and settled loans. Together with existing selected suites,
  **63 focused tests PASS** (20 projector, 10 transaction, 33 runtime preflight).
- The existing `packaged` runner now additionally executes **16 actual PostgreSQL
  cross-period checks**, using the actual verified native package and direct
  restricted settlement identity. Five sequential synthetic Payroll periods,
  November 2026 through March 2027, reduce one loan to zero with five journals,
  five repayment records and **zero salary payments**. All five can replay after
  completion without another debit to the borrower. Other cases verify prior
  cash/expense settlement, FULL payoff, fractional final installment, malformed
  historical summary, rollback on repayment-record failure and concurrency.
- Tests call the real projection and transaction functions using database-loaded
  data; they are NOT a browser UI/session or a live GCP integration test. Existing
  signed-approval fixtures remain synthetic. No blocked combined-authentication
  or new ledger-fault harness is retried.
- PostgreSQL permission suite gains one denied cash-total UPDATE check (23
  checks); the previous 35 transaction and 22 other-deduction cases remain in
  the packaged run. Do not sum overlapping families as unique acceptance.
- First integration run hit a temporary test-variable name collision; the added
  test block was scoped locally. It was not a financial or permission failure.

Command (existing local disposable runner, no real service configuration):

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/pinned/source packaged
```

The runner is still pinned to localhost:65432/payroll_ci, creates only synthetic
fixtures, and removes its container/temp artifacts after use. No live schema is
changed or cloned in full, no external email/WA/bank request is made.

## Not solved by this patch

This fixes **automatic FULL/INSTALLMENT cross-period balances**, not the separate
legacy `cash_advance_installment_schedules` reconciliation/handoff. Those pending
legacy schedules remain blocked by the original guard; it is not removed or
bypassed. Supporting that separate schedule ledger still requires matching its
allocation/repayment identity and atomic status transitions.

Source-only candidate: no deployment or live fiscal/HR configuration change.
Operational credentials/RLS, complete salary data, periods, authenticated HTTP
flow and post-commit consumers remain separate gates. Existing active DEV and
PROD data must not be described as FULL PASS on these synthetic results alone.

## Final candidate regression results

TypeScript and API build PASS. Full API **1,026 PASS /49 skipped /0 failed**.
Previous modes were rerun independently: application35, permission23 then
application35, selected guards20, native15, audited period setup25 all PASS.
Native package integrity13 PASS; unchanged financial-artifact SHA256
`a3f15c81fcd845b42d86b9258762adb7f006589cee3baef78813f9e5acdb562b`.
These external-source/PostgreSQL suites are not automatically run by standard
GitHub CI; the local results and exact-head CI must be distinguished.
