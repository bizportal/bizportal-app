# Audited Payroll financial-period registration — DEV candidate

## Existing capability reused

Read-only CST-DEV inspection on 17 November 2026 found that the existing
`bizportal_payroll_dev` login already has INSERT on only company_id/month/year of
`financial_periods`, sequence usage, scoped reads, and audit-insert permissions.
Two existing SECURITY INVOKER functions write and validate the immutable
`payroll_financial_setup_events` record. The role cannot reopen a closed period,
set an override, or edit audit history. No new grants, functions, roles, tables or
policies were installed in CST-DEV by this change.

The candidate did not have an application route using that existing contract.
`registerPayrollFinancialPeriod` and its signed-session HTTP adapter now connect
to it. This is not a replacement fiscal/calendar module and not a funding step.

## Request and transaction boundary

`POST /api/payroll/runs/:id/register-financial-period?companyId=<id>` is absent
unless APP_ENV=development and PAYROLL_DEV_FINANCIAL_SETUP_ENABLED=true. The
existing signed OTP mode, current active Super Admin lookup, company authorization
and exact HTTPS Origin check are required. Only requestId (UUID) and note are
accepted in JSON; no actor, company override, year/month, bank or approval flags.
The selected run supplies the period. A dedicated Payroll connection is mandatory;
no common pool fallback. The same existing pinned Super Admin ID/email config
must match the server-verified actor. A real browser session is NOT fabricated.

The service requires direct current_user=session_user=bizportal_payroll_dev,
without superuser/bypass/create-role/create-database rights. Within SERIALIZABLE:

1. Set transaction-local company/run/request/actor/note audit context.
2. Lock the selected run and serialize registration of its company/period.
3. Reject external accounting_period_locks entries unless explicitly unlocked.
   Reject a closed, override-enabled or previously closed/signed financial period.
4. A matching request replay verifies its original audit. An existing safe open
   period is simply reused, without inventing a new registration/approval audit.
5. An eligible draft/reviewed, pending and unposted/unpaid run may insert ONLY
   company_id/month/year. Existing defaults and triggers create the period and
   audit together. The service never inserts `period_registered` audit directly.
6. Read back the exact trigger-generated event and its actor, request, note,
   run and period. Missing or altered audit causes ROLLBACK, even when an audit
   trigger silently returns NULL. Recheck the DEV gate before COMMIT.

Only confirmed serialization/deadlock aborts are retried (bounded to three
attempts) after a successful rollback. Unknown COMMIT/network outcomes are not
retried automatically; the same caller requestId allows a later verified replay.
A failed rollback discards its connection. HTTP errors are generic and contain
no database URI, SQL, employee amount or note contents.

All results explicitly state payrollApproved=false, fundingApproved=false,
accountingPosted=false and salaryPaid=false. The service does not reopen/override
a period, approve funding, attest bank ownership, change a salary, settle a loan,
post a journal, send email/WA or transfer money.

## Configuration (not enabled by this patch)

- PAYROLL_DEV_FINANCIAL_SETUP_ENABLED=true
- PAYROLL_DEV_FINANCIAL_SETUP_ALLOWED_ORIGIN=<exact approved HTTPS origin>
- Existing signed-OTP and pinned Super Admin identity settings.
- Existing dedicated PAYROLL_DATABASE_URL_DEV, validated by payroll-db.ts.

This action registers a missing period; it does not authorize a second Payroll
approval. It must be exposed through the trusted DEV application workflow, not
used to insert a fabricated actor into live database settings from an inspector.
A production period was NOT copied: November 2026 was absent in both databases.

## Verified test boundaries

The existing disposable PostgreSQL runner now has `financial-setup` mode; no new
runner or alternate authenticated HTTP harness was created. The two actual
CST-DEV function definitions are snapshotted and checked by pg_get_functiondef
MD5 after loading. Expected hashes:

- payroll_financial_period_insert_audit: 1b9b3b853ebc81601ffa56029590d57d
- payroll_financial_setup_event_guard: 39a7f157205ce829de71aeee5d5a90c0

Tables/policies and administrative test identity are a synthetic fixture matching
the inspected registration contract; this is not a clone of the entire database.
The live policy's pinned email is replaced with admin@example.test in the fixture.
No actual employee, bank or salary data is copied. Funding is never exercised.

All three original audit triggers stay enabled throughout the final tests. Fresh
synthetic run/period IDs isolate cases without deleting/truncating audit records.
Test-only fault triggers are additive; original function bodies are not changed.

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/pinned/source financial-setup
```

25 real PostgreSQL checks PASS: exact original function hashes, one period/audit,
replay/payload collision, concurrent same/different request IDs, existing/open or
closed/override periods, external locks, company/actor boundaries, ineligible run,
failed/missing audit rollback, restricted permissions, no context leakage, direct
fake-event denial and immutable audit edit/truncate denial. Finance data stays
unchanged. Every database is ephemeral and removed by the existing launcher.

26 transaction unit tests and 37 HTTP adapter tests PASS. Those unit/HTTP cases
use simulated connections/session boundaries. Existing 44 posting-HTTP and 8
approval-mount tests also PASS (115 focused tests total, overlapping regression
coverage). The actual PostgreSQL tests call the service directly; no real signed
HTTP session or live GCP credential is claimed.

## Operational status

No period or audit was inserted in active CST-DEV or PROD in this work. November
DEV remains unconfigured until the authorized live session/dedicated connection
path is deployed and used. Settlement role/credential/RLS, full schema/outbox
behavior, real salary configuration and posting-session E2E remain separate
release gates. This candidate route is default OFF; no service restart, Nginx
switch, automatic setup DDL, funding approval or PROD rollout is performed.

## Final source regression

Full API: **1007 PASS /49 skipped /0 failed**; TypeScript/API build PASS. The
existing actual packaged native-writer PostgreSQL suite was rerun independently:
22 permission checks and 35 transaction cases PASS. These families overlap and
are not summed as unique acceptance scenarios. No live credential, browser
session, payroll approval, payment or fiscal-period insert was exercised.
