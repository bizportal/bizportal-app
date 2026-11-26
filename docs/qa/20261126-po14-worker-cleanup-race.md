# PO14 QA — worker cleanup failure on the real Owner attempt

Continuation of [PR #166](https://github.com/bizportal/bizportal-app/pull/166)
and the existing `/finance/po14-e2e-qa` page, based on commit
`976eb1a9ef3f823fbc8c0897be92bf7162090c41`.

**Status: cleanup repair deployed to the existing QA service on 26 November,
15:32 WIB. The real Super Admin session and CST scope were verified, but the
Owner's earlier attempted SQL run failed. A successful Owner receipt from the
repaired worker is still required.** Synthetic preflight actors are not Owner
acceptance evidence.

## Observed failure

On **26 November 2026 at 14:52:27 WIB**, the signed QA POST returned HTTP 503
after 5,112 ms. The page correctly refused to claim a new PASS. The local QA
database contained zero version-2 runs/audits and no leftover worker database.
The failure did not require another Google sign-in.

The isolated PostgreSQL log contained the deliberately injected audit failure,
followed by an unexpected connection termination during cleanup:

```text
07:52:27.025 UTC  ERROR: PO14_QA_AUDIT_FAILURE
07:52:27.113 UTC  FATAL: terminating connection due to administrator command
07:52:27.143 UTC  signed QA POST completed with HTTP 503
```

The audit fault is an expected rollback check. The subsequent FATAL was caused
by cleanup: the old worker started `client.end()` and `pool.end()`, then issued
`DROP DATABASE ... WITH (FORCE)` before awaiting their completion. PostgreSQL
could terminate an idle client while it was still closing. The driver's
`error` event is not a rejected `end()` promise, so `Promise.allSettled` did not
prevent an unhandled event from terminating the process.

A real PostgreSQL regression reproduced that exact old ordering by delaying
socket termination by 1,500 ms. The child exited with code 1 and the same
unhandled connection-termination error. The generated test database was removed.
Separate normal preflights could pass because this failure depends on timing.

## Repair

The worker now drains its connections before deleting its disposable database.
It checks `pg_stat_activity` for that exact generated database because
`pg-pool.end()` may resolve before all sockets have closed. Ordinary cleanup
uses a normal drop after the session count reaches zero. Cancellation or a
stalled connection can use a bounded forced drop; local cleanup error handlers
prevent the expected forced-termination event from crashing the worker.
Database removal is still verified before any successful evidence is returned.
The cleanup budget is 20 seconds plus at most two seconds for bootstrap closure,
within the parent's 25-second cancellation grace. Guards after database creation
and seeding prevent a cancelled worker from opening new client/pool handles
after cleanup has captured the existing handles.

The existing parent endpoint also records allowlisted diagnostic codes and
phases without logging child stderr, raw SQL, actors, cookies, or request
bodies. A nonzero worker exit can never become a successful receipt.

The existing page keeps its manual run button available after a worker failure
and displays a bounded diagnostic code. Authentication/scope failures require
session verification again. The page never automatically repeats a POST.

## Verification and deployment

| Verification on 26 November | Observed result |
| --- | --- |
| Cleanup regression against real PostgreSQL | **6/6 PASS**, including old failure reproduction, delayed sockets, early pool resolution, held connection, SIGTERM, and name rejection |
| Parent HTTP and real receipt SQL on fresh disposable PostgreSQL | **21/21 PASS** |
| Existing PO14 page regression | **10/10 PASS**, including manual retry and session rejection |
| API and frontend TypeScript checks and builds | **PASS** |
| Focused worker, helper, and shim TypeScript check | **PASS**, zero errors |
| Final candidate through actual bundled parent helpers and worker under the QA OS user and service restrictions | **PASS**, 11/11 evidence checks, debit = credit = 100000.00, one approval/posting/finalization audit each |
| Real receipt insert, readback, and rollback in that candidate preflight | **PASS**; transaction rolled back deliberately; no synthetic Owner receipt persisted |
| Postflight cleanup | **PASS**, zero leftover worker databases |
| Public QA page and QA JavaScript | **HTTP 200**, bytes match the candidate |
| Finance page / liveness / unsigned QA API / closed business bank endpoint | **200 / 200 / 401 / 404** |
| Business Finance runtime | Same PID **2616122** and API bundle SHA256 before and after QA deployment |

The cleanup regression's graceful paths completed in about 1.6 seconds. Its held
connection and SIGTERM paths completed in about 5.2 seconds; SIGTERM exited 143
without SIGKILL and left zero databases. The old failure case may crash before
its DROP finishes; the regression's own `finally` removes and verifies that
exact test database.

The final candidate preflight used synthetic actor `po14-owner@qa.invalid` and
finished successfully under the service restrictions in 2.267 seconds. It used
the built `executeWorker`, `validateProof`, and `readReceipt` helpers with the
actual worker bundle. This service-boundary preflight does not exercise HTTP
authentication or browser UI and creates no session. Its receipt insert/readback
ran inside a transaction that was rolled back.

At **15:33 WIB**, the QA database still had **0 version-2 receipts, 0 receipt
audits, and 0 worker databases**. This is the expected state before the Owner
retries the repaired version. A matching signed receipt, its one audit, and
receipt replay remain the final acceptance observations; they are not inferred
from the synthetic preflight.

These are targeted results for this repair. The earlier **140/140** isolated
Finance run is historical evidence from the preceding continuation and was not
rerun or added to the counts above.

### Reproduction and deployment identity

```sh
node --test scripts/qa/test-po14-worker-cleanup.mjs
node scripts/qa/build-po14-real-worker.mjs
```

The cleanup regression requires the existing localhost QA bootstrap on port
55495 and creates only generated `po14_bank_ingestion_qa_<12hex>` databases.
The parent HTTP tests use a separate fresh PostgreSQL container on port 55497.

Release: `/opt/cst-po14-real-qa-20261126-cleanup`. The existing QA service retains
port 19882, its previous authentication configuration, and disabled background
jobs. The business service on port 19881 and the Nginx routing were not changed.
Eight patched source/test files were compared by SHA256 between the working
tree and build checkout before activation.

```text
QA API:  66d220ac07518e07828db2430196197452bb688263a8f9ab81b420b19d9f0b72
QA HTML: 4ac5b80b7c46d26bebe78ee88d0b0b10d8f6369a83c5bf6f4b3c7628b0031411
Worker:  bdd0fd6547854f5dafba6e1695490d2801fd7f1310bd45ce3586c98f906f6644
Business API, unchanged:
0a1f7a291e68c2b4fad3e6a6bce465c3cb5076516a7b412cb8dea8c712a7baa8
```

The release contains `deployment-manifest.json`, `source-hashes.json`,
`postflight-http.json`, and backups of the prior QA worker and QA service
drop-in. Rollback restores those two backups and restarts only the QA service.
Previously served hashed assets remain available to tabs open during the update.

## Scope

This is a repair to the existing isolated QA implementation. Test transactions
remain in uniquely named localhost QA databases. No business Finance runtime
replacement, CST-DEV business transaction, real bank transfer, or PROD write
is part of this change. Sheet input remains `synthetic_fixture`.

Principal sources: `scripts/qa/po14-worker-cleanup.ts`,
`scripts/qa/po14-real-worker.ts`, `scripts/qa/po14-worker-shims/db.ts`,
`artifacts/api-server/src/routes/dev-finance-po14-e2e-qa.ts`, and the existing
PO14 page and its regression tests.
