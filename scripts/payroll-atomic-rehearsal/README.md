# Native Payroll Accounting — disposable atomicity rehearsal

**STAGED PATCH / NOT ACTIVATED.** This directory does not mount a route, enable a
writer, grant any live database role, or modify the deployed legacy source. The
patch is for the existing `accounting.ts` and `PayrollJournalService.ts` at the
SHA-256 identities in `provenance.json`. It is applied only to temporary copies.
There is no second journal posting engine. The original accrual line builder,
sequence mechanism and `postEntryWithClient` remain the financial implementation.

## Run

After installing the repository's locked dependencies and providing an existing
local `postgres:16-alpine` image, run:

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/path/to/legacy-source
```

The launcher uses an empty environment except PATH/HOME and a deliberately
synthetic local CI connection. It refuses an occupied localhost port 65432,
creates a new memory-backed PostgreSQL container and deletes only that container
on completion or failure. No live service env, GCP keys, Supabase connection or
bank credentials are read. The runner refuses every non-local database URL and
checks hashes of the native source and unchanged dependencies before patching.

## Verified defect and staged change

The unmodified old `postEntryWithClient` rolls back its journal with the caller,
but invokes ledger audit and outbox writes on the global connection. The fixture
reproduces **zero journals but a remaining audit/outbox record** after rollback.

The staged patch keeps root-client behavior unchanged. When the caller supplies
a transaction client, audit, checksum and outbox writes use that same client and
are awaited. An audit/outbox failure aborts the financial transaction. Sequence
or enum failures do not invoke global-query/DDL recovery outside the transaction.
The native Payroll accrual method accepts an optional transaction client and
passes it to journal selection and the existing posting core. Its financial
lines are unchanged. Immediate background spot checks are not dispatched before
commit; the durable outbox is inserted transactionally. Actual post-commit
consumer behavior remains a separate integration gate.

## Evidence: 15 checks passed on PostgreSQL 16.15

The fixture uses real PostgreSQL, real Drizzle queries, the native financial
writer and real INSERT/UPDATE/COMMIT/ROLLBACK. It verifies a restricted synthetic
role with RLS, not a live Supabase login. Successful posting persists one journal,
its lines, one audit/outbox event, one kasbon deduction and one Payroll status
transition while preserving the prior approval date/receipt. Failed operations
after journal, after kasbon and after Payroll leave none of those partial changes.
Concurrent calls produce one journal/deduction; replay reuses it. Foreign company,
locked period, changed approved salary, changed kasbon balance, failed audit/outbox/sequence, and
an unposted journal on replay are rejected.

**Test-only boundaries:** the orchestrator in `native-postgres-tests.ts` is a
fixture, not the production Payroll endpoint. The fixture's active employee and
cash-advance approval/disbursement metadata are synthetic. Its RLS policy/grants
are representative, not a clone of all CST-DEV policies. The journal/audit/outbox
schema is generated from canonical Drizzle types plus required legacy columns,
with minimal fixture constraints; the full production trigger set is not copied.
Migration/seed/background-notification dependencies are isolated traps or no-op
adapters; financial SQL and transaction outcomes are not mocked. The original
outbox adapter's global INSERT behavior is retained for the baseline reproduction.
No live HR data, session, salary payment or bank transfer is used.

## Remaining release gates

This is not a deployed Payroll-to-Accounting integration. Before applying the
patch to the selected runtime, port it through the canonical legacy-parity work,
verify all existing transaction-client consumers and actual audit/outbox schema,
validate journal company/source/status/line signatures under the same lock, and
wire the real Payroll/Kasbon ledger to the same transaction. Preserve current
approval evidence; do not rewind reviewed to calculated or introduce another
human approval. Live credential, signed-session, effective salary data and
complete E2E tests are still required. Nonzero `otherDeductions` still fails closed
until an explicit legitimate mapping is supplied; this patch does not invent one.

The existing application API, typecheck/build and CI do **not** automatically run
this external-source rehearsal. A PASS here must be reported separately from CI.

## Application-service suite added

The original `native` suite above remains unchanged in scope. A second suite
now calls `src/routes/payroll-accounting-transaction.ts` directly, including
real cash-advance repayment rows, source/account-line verification, preserved
microsecond approval timestamps, and 17-person coverage. Run with the optional
`application` argument to the same launcher. See `APPLICATION-SERVICE.md` for
its exact activation, schema, authentication and outstanding runtime limits.
Neither suite enables an HTTP endpoint or changes an active service.
