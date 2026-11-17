# Selected actual DEV guard compatibility — staged only

## Defect reproduced and narrowly corrected

The earlier transaction-bound patch updated `checksum_hash` after promoting a
journal to `posted`. CST-DEV has the existing `trg_block_posted_update` trigger,
whose `fn_block_posted_entry_update` function rejects that UPDATE. The earlier
representative fixture did not contain this strict trigger. Therefore previous
application-suite PASS was not evidence of compatibility with this DEV rule.

The `triggers` suite retrieves the EXACT previous patch from Git commit
`743e2345eba2c577e4152aeee397758579352593`, verifies its SHA-256, applies it to
separate temporary copies of the pinned legacy source and reproduces the
immutability failure, including full financial rollback. It then tests the
revised staged patch against the same guards and restricted/RLS role.

For explicit transaction clients only, the revised patch writes checksum and
previous-entry metadata while the new journal is still `draft`, checks that
exactly one matching draft row was updated, then performs the existing posting
transition. It does not update the posted journal again. Root/global behavior,
financial line formulas, approval receipt and accounting sources are unchanged.
No trigger is disabled or weakened, and no correction/bypass setting is enabled.

## Snapshot scope

`dev-selected-guards.sql` contains four actual functions read with
`pg_get_functiondef` from CST-DEV on 17 November 2026 and the six selected trigger
registrations using those functions. A PostgreSQL `md5(pg_get_functiondef(...))`
comparison verifies all four function definitions match the read-only snapshot
values recorded in `dev-selected-guards-provenance.json`.

Included: strict posted-entry mutation guard, all three posted-line mutation
guard events, reviewed Payroll item guard, and reviewed Payroll status guard.
This is **NOT** the full live schema, RLS, grants, trigger set, or session path.
In particular, the legacy line-to-Fleet-ledger synchronization trigger, other
entry/period/company guards and post-commit consumers are NOT cloned in this
suite. A full runtime release still needs those independent checks. No live
metadata definitions or privileges are altered by the rehearsal.

## Run

From this repository with locked dependencies, exact existing legacy source
and the local PostgreSQL 16 image:

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/legacy/source triggers
```

The runner needs the pinned previous Git commit to be available locally; it
fails closed rather than fetching an alternative source if unavailable. All
connections remain limited to the existing disposable loopback fixture.
No Supabase URL, live credentials, cookies or bank details are accessed.
The temporary container, port and compiled source copies are cleaned up.

## Verified results

20 selected-guard checks PASS, including exact function snapshot matching,
previous-patch failure reproduction, successful posting and replay with all
six triggers enabled, forbidden posted journal/line edits, unchanged reviewed
Payroll, metadata and promotion failure rollback, silently suppressed metadata
update rejection, outbox/repayment/payroll failure rollback, tenant denial and
concurrent idempotency. The existing application suite remains 35 PASS and
original native suite 15 PASS when rerun with the revised patch; overlapping
scenarios must not be added as unique acceptance coverage.

The patch is applied only to temporary source copies. No active service, live
DB grant, financial record, login or PROD deployment is changed. The full
signed HTTP → live DEV transaction remains unverified; this work does not
attempt to bypass prior tool security restrictions on that separate test.
