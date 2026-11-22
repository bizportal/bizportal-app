# Reviewed Payroll → existing Accounting: preparation only

`prepareReviewedPayrollAccrual` is a pure, read-only preflight. It reuses the
existing Payroll preview arithmetic, approval receipt/digest and kasbon
reservation validation. Its output `mapping` and `params` match the pre-existing
`PayrollJournalService.postAccrualJournal(mapping, params)` contract. No endpoint,
feature flag, database privilege, payment, journal, or active service is enabled.

## State and authorization boundary

- Accept only an unposted `reviewed` run with an approval timestamp and a durable
  Super Admin receipt that exactly matches the current, complete item snapshot.
- Do not reinterpret unsigned historical HR `reviewed` as approved. Never reset
  `reviewed` to `calculated` just to pass the old route's status check.
- Source stays `payroll`, sourceId stays run ID and reference stays `PAYROLL-<id>`.
  The eventual transition is `reviewed → approved` after a verified journal,
  not a second human approval. Existing linked journal/payment pointers block
  fresh preparation and require a separate verified replay path.
- The function does **not** authenticate a browser session or database identity.
  Receipt parsing is not cryptographic verification of the current operator.
  Callers must authenticate, enforce company scope, obtain current database rows,
  lock/revalidate them and use a narrowly scoped writer.

## Components and safeguards

Active employee IDs, item IDs and employees must be unique, cover the whole
roster, be unpaid, and have exact integer-cent totals. Account metadata must be
explicitly company-matched, active, postable, non-header and of the correct type.
Kasbon must match the existing prepared reservation evidence, remain within its
balance, and have a valid receivable account. No kasbon is settled by preflight.

The old five-account accrual method does **not** represent `otherDeductions`.
A one-rupiah other deduction was reproduced as a one-rupiah credit shortage in
the original line builder. Preflight rejects any nonzero `otherDeductions` with
`PAYROLL_HANDOFF_OTHER_DEDUCTION_MAPPING_REQUIRED`. It never zeroes the amount,
credits an arbitrary account, or silently adjusts salary payable. Full support
requires a legitimate explicit mapping and a focused change to the existing
writer before release; this guard is not a completed implementation of it.

## Verification and remaining integration gate

The targeted suite covers salary drift, incomplete/duplicate/paid items,
legacy unsigned review, tenant isolation, bad account metadata, kasbon evidence,
repeat posting pointers, posting dates and unrepresented deductions. A separate
isolated invocation of the original legacy `PayrollJournalService` produced
balanced lines for a mixed-component example and a 17-person synthetic roster.
Only its external database/posting boundary was replaced with a capture stub.
This proves input/line-composition compatibility, **not real GL posting**.

The original `postAccrualJournal` invokes the global `postEntry` before the
legacy route completes its separate payroll/kasbon transaction. Do **not** mount
that route or call it directly from this preflight. The next integration must
reuse existing `postEntryWithClient` / transactional writer plumbing so journal,
kasbon confirmation and payroll linkage share ONE transaction and idempotency
lock. Verify returned journal company, source identity, status and amounts.
Then test rollback after a partial failure, replay, concurrent approval and
payment evidence on disposable DEV data. PROD remains untouched until all
operational gates pass.

## Other-deduction support update — 17 November 2026

The original unconditional nonzero-other-deduction rejection described above is
now narrowed: the candidate accepts an explicitly configured, validated
same-company `payroll_coa_mappings.other_deduction` liability mapping and the
existing native patch writes its exact credit. Missing/invalid mappings remain
blocked. No live configuration is created, and legacy installment gates remain.
See `scripts/payroll-other-deductions/README.md` for current cases, changed
artifact fingerprint, permission requirements and remaining release limits.
