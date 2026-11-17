# Runtime binding: read-only structural preflight (DEV candidate)

## Gap addressed

The existing trusted `bindDevPayrollAtomicHttpRuntime` accepted a pool and a
versioned native writer synchronously, without validating the pool's effective
database identity or privileges before publishing the binding. The transaction
itself checked identity, but an installed binding was not readiness evidence.
There is still no production startup call assembling the patched native artifact
and its separate credential; this change must not be described as deployment.

The SAME binder is now asynchronous. A controlled server bootstrap must await
it. It validates the supplied pool in a **REPEATABLE READ, READ ONLY** transaction
and ends that transaction with ROLLBACK before publishing the runtime object.
It does not obtain a secret, create a role, change permissions or submit posting.
It neither introduces a fallback pool nor invokes a financial writer.

## Structural contract

`payroll-accounting-runtime-preflight.ts` checks:

- Direct current_user/session_user both equal the dedicated settlement login;
  LOGIN is allowed but superuser/bypass/role-creation/database-creation/
  replication/schema-create privileges and alternate inherited/SET roles are not.
- 18 fixed public relations exist as actual tables, with RLS, an applicable
  permissive SELECT policy and (where needed) INSERT/UPDATE policy presence.
- Required SELECT and individual INSERT/UPDATE columns and sequence usage are
  available. Table ownership, whole-table UPDATE, DELETE/TRUNCATE, selected
  protected financial/approval fields and any salary-payment write are refused.
- The transaction is actually read-only with a repeatable snapshot. Only
  catalog reads, local timeouts, transaction control and ROLLBACK are performed.
  No employee/salary row, browser cookie, OTP or secret payload is read.
- Connection/query errors are redacted. A failed ROLLBACK discards the borrowed
  connection. Until completion, HTTP still returns runtime-not-bound. Concurrent
  identical startup calls share the check; a different pending/replacement
  binding is rejected. Turning a feature OFF mid-check prevents installation.

This is a point-in-time structural gate, NOT a proof of all effective policy
semantics, all SQL/trigger dependencies or live E2E. A policy with a permissive
expression can pass the presence check; semantic tenant tests remain mandatory.
The lock-only mutation guard from the reduced-permission fixture must also be
reviewed independently. INSERT on native journal headers/lines remains table-
level under row policy. Credential endpoint/TLS pinning and verified native
artifact provenance remain responsibilities of trusted bootstrap; this module
cannot infer a host from a generic pool or trust an unverified writer marker.
Per-request authentication, digest, role identity and transaction guards remain.

## Verification

- 33 pure preflight tests verify rejection and cleanup using simulated query
  responses. 44 HTTP-boundary tests verify binding order/failure/races; their
  session and posting functions remain simulated. **77 focused tests PASS**;
  this is not the previously blocked combined authenticated HTTP→SQL harness.
- The existing disposable `permissions` suite now calls the real preflight on
  the direct restricted PostgreSQL connection. It passes all 18 table checks
  and leaves the data unchanged. **22 permission checks plus 35 existing
  application transaction cases PASS** (overlapping evidence, not a unique
  aggregate acceptance count). No HTTP session is created in this suite.
- Two ancillary legacy evidence tables in that fixture previously lacked RLS;
  the fixture-only profile now adds company-scoped SELECT policies through the
  existing payroll/advance parent rows. Live metadata independently confirms
  these live tables already have RLS but lack settlement access/policies.
- The first preflight fixture invocation correctly rejected an unset APP_ENV;
  its test context was made explicitly DEV and restored afterward. The runtime
  gate was not weakened. No live permission, LOGIN or SET ROLE was used.

Runtime TypeScript/build and full API regression: **890 PASS /49 skipped /0
failed** on the final source candidate. External-source PostgreSQL suites are
separate from the normal CI tests and must be reported separately.

## Live status and next boundary

Read-only CST-DEV metadata confirms settlement still NOLOGIN, no elevated role,
no schema creation, no usable inherited roles. Ledger, outbox, audit, repayment,
sequence and the two legacy evidence tables all retain RLS and lack settlement
SELECT/policies. These missing rights are NOT silently granted by the checker.

The role and credential, patched native runtime artifact, fiscal period and
complete verified payroll data still need controlled setup and live validation.
`index.ts` does not automatically bind this writer, and this change does not
modify active services, Nginx, bank/WA/email transports, Supabase privileges or
PROD. The preflight is a required step toward safe assembly, not FULL PASS.
