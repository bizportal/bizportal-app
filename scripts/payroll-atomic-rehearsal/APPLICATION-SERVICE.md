# Application-owned Payroll accrual transaction (DEV candidate)

## What now runs as application code

`artifacts/api-server/src/routes/payroll-accounting-transaction.ts` owns the
transaction instead of the synthetic orchestration in `native-postgres-tests.ts`.
The application service loads the actual locked run, items, active employees,
five-account mapping, account metadata, reservations and cash-advance evidence.
It calls the **existing native PayrollJournalService**, bound to the same PG
client through Drizzle, and re-reads the persisted journal and financial lines.
It does not implement a second journal engine or insert journal lines itself.

The service records a kasbon repayment in the existing `cash_advance_repayments`
table with an explicit idempotency key, updates paid/settled/remaining amounts
and legacy lifecycle states, confirms reservations, and links the Payroll run
in ONE serializable transaction. It preserves the original approval receipt and
timestamp, including PostgreSQL microseconds, and records `posted_at`. It never
rewinds reviewed to calculated, asks for a second approval, creates a salary
payment or performs a bank transfer.

Successful replay verifies both the posted journal's exact company/source/ref,
amounts and account-line signature, and the complete matching repayment ledger.
Missing/changed repayments are refused, not silently repaired or deducted again.
Failures of journal, balance, repayment, confirmation, run-link, audit, outbox or
sequence roll back together. Serialization/deadlock failures have a bounded
retry only after rollback. Network/ambiguous-commit failures are not auto-retried.

## Binding / security boundary — NOT deployed or exposed

The separately guarded HTTP adapter now imports this module, but no live binding
is configured. It stays unavailable unless BOTH
`APP_ENV=development` and `PAYROLL_DEV_ATOMIC_POSTING_ENABLED=true` are explicit.
It verifies the actual session and effective PostgreSQL user are the separate
`bizportal_payroll_settlement_dev`, neither superuser nor BYPASSRLS, and uses
transaction-local company scope. It does not load credentials or fall back to
a shared pool. No new role grants, LOGIN activation or secrets were provisioned.

The actor parameter is **not a login mechanism**: a trusted server caller must
first verify the existing signed Super Admin session and company selection.
Never pass arbitrary actor data from HTTP JSON. It must match the persisted
approval actor/digest. The source module alone does not establish browser auth.

The existing native service must have the SHA-pinned transaction patch applied
and expose `transactionalAccrualVersion='payroll-accrual-atomic-v1'`. The unpatched
global-posting service is refused before connecting. This marker is a binding
compatibility check, not authorization or a substitute for audited source.
The native patch remains applied to temporary test copies, not active services.

## Exact test scope

Run both independent suites with the locked dependencies and an existing local
PostgreSQL 16 image:

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/legacy/source application
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/legacy/source native
```

The application suite calls the actual application module and the patched native
financial writer. SQL, row locks, repayment INSERTs, COMMIT and ROLLBACK are real.
Its tables are built from canonical accounting models plus verified CST-DEV
column contracts. It includes representative restricted-role RLS, repayment
uniqueness and the reviewed-state guard, but is **not a clone of all live
production triggers/policies**. Employee IDs, approvals, salaries and loans are
synthetic, no live Supabase or bank credentials are available. The old baseline
regression remains part of the suite. Standard API CI does not automatically
run these external-source native/application suites; report them separately.

Application results: 35 checks PASS, including one baseline reproduction.
Original native suite retained: 15 checks PASS. These overlap; do not add them
as 49 unique business acceptance scenarios. The new application's standard
activation tests additionally verify default OFF and production denial.

## Before an active DEV release

The HTTP handler is registered only behind explicit default-OFF DEV flags, and
the restricted pool/native writer binding is not integrated into the selected runtime. The actual restricted role/pool, full RLS/trigger
compatibility, signed-session route and post-commit outbox consumers still need
assembly and E2E verification. The dedicated role remains NOLOGIN in CST-DEV.
Fiscal posting must have exactly one configured company/month period; missing
periods fail closed. Read-only metadata inspection showed no November 2026
company-1 fiscal period, so this is an explicit prerequisite, not silently open.

Nonzero `otherDeductions` still requires legitimate account mapping. Legacy
`payroll_cash_advance_allocations` overlapping the run is rejected to avoid
mixing two settlement ledgers. Loans with pending/overdue legacy installment schedules are also explicitly
rejected before the writer. Their schedule linkage is NOT implemented by this
automatic-reservation adapter and must be reconciled before those loans qualify. The verified HR data and
live roster must be prepared without treating synthetic fixtures as real pay.
Do not enable a writer or deploy PROD based only on these passing tests.

See `SIGNED-HTTP-BOUNDARY.md` for source-level HTTP guards and the explicit
limits of the separately tested HTTP and PostgreSQL layers.

## Selected actual CST-DEV guard compatibility (17 Nov follow-up)

See `SELECTED-DEV-GUARDS.md` and the `triggers` suite. The earlier atomic
patch's checksum-after-posting UPDATE was reproduced as incompatible with
the live DEV immutability guard. The staged patch now finalizes metadata in
Draft before promotion, without weakening any guard. Four copied function
definitions match live read-only metadata hashes; six selected trigger
registrations are enabled in the isolated fixture. 20 checks PASS; this is
not a complete clone of every live trigger or a signed HTTP E2E result.
