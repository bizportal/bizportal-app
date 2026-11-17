# Restricted settlement permissions — disposable proof only

## Purpose and boundary

The earlier application fixture granted table-wide UPDATE on financial tables.
Its success did not establish that the existing service could run with narrower
rights. The `permissions` mode runs the existing native/application transaction
with a reduced, explicit fixture-only privilege profile, followed by all original
35 transaction scenarios. No new financial writer, auth mode or live grant is added.

This is NOT a deployable migration or an authorization to activate a role.
`least-privilege-fixture.sql` refuses a database other than `payroll_ci`, the
fixture setup identity, and missing synthetic COA sentinel. The unchanged shell
launcher additionally pins disposable PostgreSQL to 127.0.0.1:65432, uses tmpfs,
injects only its synthetic test credential, and removes the container. It does
not read secrets, session cookies or user data. No SQL from this profile is sent
to Supabase. No inspector is granted SET ROLE.

## Tested narrower contract

- No table-wide UPDATE, DELETE or TRUNCATE on any fixture public table.
- No write to approval date/receipt, salary item amounts, loan principal or
  receivable COA, salary-payment link, salary payment rows or schema objects.
- Payroll status/link/posting fields, actual settlement balance/status fields,
  reservation confirmation, checksum/status and sequence counter have explicit
  column-scoped UPDATE grants. Insert grants on repayment, audit, outbox,
  ledger mirror and sequence data are column-scoped.
- INSERT on journal headers and lines remains table-level because the unchanged
  Drizzle builder emits DEFAULTs across its declared schema. Existing tenant RLS
  plus extra restrictive Payroll source policies limit those fixture rows.
  This is therefore a **tested reduced privilege profile**, not a mathematical
  minimum or a proof against arbitrary SQL by a compromised trusted writer.
- PostgreSQL FOR SHARE/FOR UPDATE needs UPDATE rights on at least one column.
  Lock-only tables get a single column privilege plus a fixture-specific
  SECURITY INVOKER trigger denying **every actual UPDATE by the writer**.
  Row locks work; no-op updates to that column are denied. Existing immutable
  journal/ledger/review protections are not relaxed. This additional trigger
  does not exist on the live database and would need separate reviewed rollout.
- Existing source/tenant policies stay active. No elevated connection, owner
  bypass, SUPERUSER or BYPASSRLS is used by the posting service.

PostgreSQL 16 references: `https://www.postgresql.org/docs/16/sql-select.html`
(SELECT privileges and locking) and `https://www.postgresql.org/docs/16/ddl-rowsecurity.html`
(default-deny and restrictive policies). Credentialed service company scope is
still set by trusted application code; it is not end-user authentication.

## Verification

Run with the already pinned legacy source snapshot:

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/legacy/source permissions
```

21 new actual PostgreSQL privilege checks PASS, including direct role identity,
ACL metadata, denied writes and real row locks, cross-company denial and absence
of scope leakage after ROLLBACK. Then 35 existing application scenarios PASS on
the same restricted pool, including normal post/replay, concurrent requests,
partial/full/zero kasbon, 17 employees and injected transaction failures.

One old test deliberately modifies a journal account through a malicious writer
callback. The limited role now rejects that UPDATE earlier with exact SQLSTATE
42501. Only in this profile, the expectation is changed from later read-back
`JOURNAL_LINES_CHANGED` to that exact ACL denial; rollback assertions remain.
Default application mode and all other scenarios remain unchanged. No test was
removed or allowed to pass on arbitrary errors.

These test families overlap and should not be summed as unique business
acceptance coverage. An initial run failed at the old error expectation; that
was corrected explicitly, not by restoring broad UPDATE permission.

## Actual DEV remains locked

Read-only CST-DEV metadata on 17 November 2026 shows the settlement role is still
NOLOGIN/NOSUPERUSER/NOBYPASSRLS and lacks the operational ledger/outbox/repayment
rights. Its membership entry gives postgres administration but INHERIT=false
and SET=false; that is not a leftover impersonation grant. No memberships were
changed. Ledger and outbox RLS remain enabled without policies for this role.

The five-account mapping is present, but fiscal period, complete verified HR
salary/deduction configuration, live least-privilege policies/constraints, secure
credential custody and authenticated HTTP→SQL assembly remain separate gates.
This file grants no authority to change them. Full runtime/PROD release remains
NO-GO until those checks and authorized rollout are completed. Previously blocked
combined authentication/SQL and extra ledger-fault harnesses are not recreated.
