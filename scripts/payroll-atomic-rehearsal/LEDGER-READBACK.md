# Existing ledger synchronization: read-back validation (DEV candidate)

## Observed metadata and source risk

Read-only CST-DEV inspection on 17 November 2026 found an existing
`trg_sync_entry_line_to_ledger` AFTER INSERT trigger on accounting journal lines.
Its `fn_sync_entry_line_to_ledger` function writes `fleet_ledger_entries` but
catches INSERT exceptions as warnings and continues. Thus a successful journal
INSERT does not by itself establish complete ledger synchronization. This is a
source/metadata finding; a new ledger-failure SQL reproduction was NOT executed.

`fleet_ledger_entries` in the inspected DEV database has RLS enabled, no policies,
and the dedicated settlement role remains NOLOGIN without SELECT/INSERT/locking
privileges for this table. No live privileges, policies, triggers or data were
changed. A successful disposable role configuration is not a live permission fix.

## Narrow application change

`payroll-accounting-ledger.ts` is a pure, read-only assertion. The existing
transaction service now reads both journal lines and synchronized ledger rows
from its same restricted connection before kasbon settlement and also on replay.
It requires exact source/company/run/reference/date/period/currency and nonvoid
state, and compares the complete multiset of account IDs, integer-cent debit,
credit and descriptions. It rejects missing, extra or changed lines even when
aggregate journal totals balance. It never recreates ledger rows, re-deducts a
loan, disables a guard or falls back to an elevated connection. Missing SELECT
privileges also fail closed. Account code/name display snapshots are not
validated against mutable current COA descriptions by this assertion.

## Verification performed

- 31 pure comparison tests PASS. Inputs cover missing/duplicate rows, wrong
  source/account/date/reference/currency, voided evidence, equal-total line
  alterations and invalid amounts. These tests use synthetic arrays, not SQL.
- 75 focused unit tests PASS including existing handoff and activation tests.
- The pre-existing application PostgreSQL suite was run unchanged in scenario
  scope: 35 PASS, now with the existing sync trigger and ledger table in its
  fixture, and the new read-back assertion in the real transaction service.
  The pre-existing selected guard suite remains 20 PASS and native suite 15 PASS.
  These groups overlap and are not a combined business-acceptance count.
- Three ledger-related function definitions are copied byte-for-byte as
  `pg_get_functiondef` SQL, and their database-computed MD5s match the read-only
  metadata snapshot in `dev-ledger-sync-provenance.json` during the application
  fixture setup. Grants/RLS policy in the successful fixture are deliberately
  synthetic and narrowly company-scoped, NOT a clone of live effective access.
- Final standard API: 853 PASS /49 skipped /0 failed. API TypeScript/build PASS.
  The old baseline audit/outbox regression in the existing suite still runs;
  it is NOT a new reproduction of silent ledger synchronization failure.

A proposed additional SQL harness for ledger-specific injected failures was
blocked by tool security before creation/execution. It was not retried through
another channel; preparatory runner changes were removed. No `ledger` suite or
`ledger-compatibility-tests.ts` was added. Its results are NOT counted as PASS.

## Deployment boundary

Source candidate only, default financial routes/flags remain OFF. No active
service restart, credential retrieval, browser session handling, live DDL or
financial writes. Full signed HTTP → SQL, live privileges/full trigger set,
post-commit consumers, legitimate salary/deduction/fiscal-period setup and
unsupported deduction/legacy installment cases remain independent release gates.
The new ledger read-back requires an explicitly authorized company policy and
least-privilege SELECT/INSERT plus PostgreSQL row-lock permission in the real
runtime. Do not grant broader roles or disable RLS to make a test pass.
