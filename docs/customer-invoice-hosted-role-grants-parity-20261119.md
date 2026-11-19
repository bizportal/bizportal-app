# CST-DEV Invoice writer: exact column-GRANT parity against real PostgreSQL metadata

**Source/isolated test only. Release: NO-GO. No hosted DB schema, roles, Invoice
records, payments, credentials or PROD data are changed.**

## Why this check was required

Earlier combined Owner OTP → original Accounting E2E in PR #156 proved
GL, PPN, AR, audit, outbox, replay and rollback with source-pinned code,
but disposable writer roles were deliberately granted broad table rights.
Such rights were too generous to reveal missing permissions on hosted CST-DEV.

This test fetches only role privilege metadata (no customer rows or secrets)
for both real DEV writers through a READ-ONLY Supabase SQL query. Generated
`scripts/tests/customer-invoice-hosted-20261119-grant-parity.sql` has
22 source, accounting, customer-notification and identity tables, and nine
original sequence USAGE grants. Both writer roles have the same column
privileges on these listed objects. The SQL is database-name guarded to
`invoice_synthetic` and applied **only** to a disposable PG16 container.

PG16 begins with the original PR #142 disposable Accounting schema. The
test fixture adds the minimal Customer Portal tables absent from the old
BizPortal QA schema and a `created_at` field on the synthetic audit table
to match the active schema. These are QA fixture changes, not product code.

## What the exact privilege baseline proved

After revoking the synthetic broad grants and applying the cloned hosted
role permissions, two reproducible blockers were detected:

1. Neither writer can INSERT the original Portal PR #231 required audit
   columns `change_reason` and `after_state`. The original B1/B4 source
   and company RLS protects the audit, but PostgreSQL column INSERT is
   still required.
2. Neither writer has the narrow UPDATE(column) privilege PostgreSQL
   needs for `SELECT ... FOR SHARE` on `accounting_settings` and
   `accounting_taxes`, even with their SELECT privilege. This is why the
   original signed financial snapshot alone cannot prevent a tax mapping
   update from racing an Invoice COMMIT.

These failures are confirmed with negative tests **before** applying any
proposed corrections in the disposable database.

## Exactly which changes were tested in the disposable database

- PR #157's proposed **only** `INSERT(change_reason,after_state)` on
  `audit_accounting_events` for the two direct writer roles, independently
  covered by the original restrictive company + posted-journal B4 checks.
- PR #231's previously reviewed B6 proposal, narrow
  `UPDATE(updated_at)` / `UPDATE(created_at)` timestamp column rights
  solely to permit `FOR SHARE`, together with its new RESTRICTIVE
  `FOR UPDATE ... WITH CHECK(false)` company RLS policies. Actual edits
  to these timestamp columns remain denied in separate PG16 tests.

With the real existing column GRANT snapshot plus **only** these two
candidate changes, the exact original CanonicalPostingEngine and Portal
PR #231 + BizPortal PR #155 synthetic signed Owner flow passed for CST
and Diva on disposable PG16: journal, PPN, AR, audit and outbox in the
original transaction, and independently signed replay with no duplicate.
Wrong-Invoice OTP proof is rejected and rolls back without a journal.

## What is still not proved

- We cloned actual SQL privileges but used isolated company-scoped RLS
  policies. This is not a byte-for-byte clone of every hosted Supabase
  function, trigger, and policy; actual hosted least-privilege E2E
  remains an independent release gate.
- OTP email issuance and the actual customer-facing BizPortal HTTPS
  browser/device session were simulated; no live Owner OTP was read.
- Both Invoice writer roles on CST-DEV remain NOLOGIN/NOBYPASSRLS.
  There are no new to_invoice documents for CST/Diva and no active
  Invoice AR source actor. All financial release flags remain OFF.
- The original Accounting owner bundle is QA-staged separately, not
  mounted into the active Customer Portal. No active DEV or PROD financial
  posting has been executed.

**Decision: isolated ACL-parity acceptance PASS, hosted financial GO still
blocked until a time-bounded, owner-authorized DEV release/rollback gate.
Do not grant broad access, create fake financial data on hosted systems,
or merge/deploy these Draft candidates automatically.**
