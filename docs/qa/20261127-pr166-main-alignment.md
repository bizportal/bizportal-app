# Finance PR #166 — scoped alignment to official `main`

## Source and isolation

- Target repository: `bizportal/bizportal-app`.
- Base `main` SHA: `3540666d193ee31ee54e5af40fd0d305da08e2dc`.
- Previously merged PR: #166, merge SHA `4e9f907634dd3dbea0f8f0928ed7f46f9c43a6f9`, originally merged into `fix/finance-dev-signed-vendor-list-20261119`, **not** `main`.
- Direct historical merge was rejected in the disposable integration worktree because it would bring unrelated divergent history and eight merge conflicts.
- Instead, the PR #166 scope-only delta (52 paths) was applied three-way to current `main`, with five bounded conflicts resolved without importing the side branch's other commits.
- The `main` Vendor Invoice list was preserved: PR #166's preview-mode condition referred to UI flags and query guards absent from `main` and is not required for the separate PO14 QA page.
- Existing `main` signed email OTP login was retained. Only the signed Finance company-scope helper functions and the original FinanceCompanyScopeCard/client helper were added as dependencies, with strict DEV flags and session-bound scope.
- No changes made to live Finance services, Supabase business databases, Google Sheet sources, or PROD. No new PO #14 business transaction was created. Previous real Owner QA receipt is preserved; this integration did not replay that transaction.

## Targeted regression on integration worktree

| Check | Result |
| --- | --- |
| `git diff --cached --check` | PASS |
| API TypeScript typecheck | PASS |
| API build | PASS |
| Frontend production bundle build (Vite) | PASS (sourcemap/chunk-size warnings only) |
| Signed OTP / dev-auth / Marketplace writer / approval QA | 57/57 PASS, 4 files |
| Finance approval / Invoice-bank adapter / Payment finalization, disposable localhost PostgreSQL | 43/43 PASS, 3 files |
| Finance UI PO14, Vendor Invoice payment status/sync, approval QA | 19/19 PASS, 4 files |
| UI TypeScript typecheck after preserving main Vendor Invoice list | **PASS** |

The first dry-run of three SQL suites produced `ECONNREFUSED` only because no test PostgreSQL was running on 55493/55494/55497. The focused rerun used three temporary `postgres:16-alpine` containers, which were stopped by the test script. The first UI dry-run needed FinanceCompanyScopeCard and its existing signed-selection helper from the source branch; after bringing in those dependencies, all 19 UI tests passed.

Database-based tests use synthetic fixture records and local PostgreSQL; no CST-DEV or PROD Supabase DSN was available to the process. This is compatibility regression, not a fresh end-to-end Owner operation or real Google Sheet import. The historical Owner QA result (1 receipt, 1 audit, balanced IDR 100,000 and zero leftover databases) remains independent evidence.

## Release boundary

This branch is a proposed integration into official `main`, not a deployed release. All Finance writes remain behind the existing DEV-only feature gates. Do not enable bank sync, do not generate PO14 business Invoice/AP/GL, do not deploy PROD, and do not regard the 2026-11-26 isolated QA receipt as business payment authorization.

## Release Gate CI isolation follow-up

Initial PR #284 Release Gate run `45970653021` failed only because seven Finance SQL test suites tried to connect to absent dedicated localhost PostgreSQL ports 55493, 55494, 55495, and 55497. Its general API suite reported **1,043 passing tests**; the seven file-level connection refusals occurred before their SQL tests ran. The PR's other workflows (OTP, QRIS, Reconciliation, Bank Sheet Orphan Guard) passed.

The pre-existing `release-gate.yml` now keeps those database-dependent files out of the general API step and invokes the existing `run-po14-isolated-marketplace-e2e.sh` as the next mandatory Finance step. That runner provisions disposable PostgreSQL containers for all required ports, seeds a separate approval-only fixture on 55495, runs the Finance SQL tests serially to avoid concurrent fixture resets, and stops all test containers on exit. Nothing targets the long-lived QA service or Supabase. The VPS preflight correctly **refused** to bind port 55495 because it is in use by the existing QA instance; GitHub Actions provides a separate fresh VM for the new CI run.

This workflow correction does not repeat the authenticated Owner browser test and does not touch a live finance database. A new Release Gate result must be observed before any merge to `main`.

### CI fixture compatibility (second Release Gate attempt)

The second Release Gate separated general API tests successfully (**1,043 PASS**), but two disposable-fixture incompatibilities blocked the SQL step: the test-only approval scenario ID was declared `bigint` (Node's `pg` returned a string instead of the expected integer), and PR147's new DEV source guard rejected synthetic bank writes because the isolated test did not set `BANK_SHEET_DEV_WRITES_ENABLED`.

The approval fixture now uses `integer` IDs. Only `marketplaceBankIngestionRealPg.test.ts` sets `BANK_SHEET_DEV_WRITES_ENABLED=true` with `vi.stubEnv` inside its own `beforeEach`, and clears it after tests. No application runtime, CI global environment, or business database has that write flag enabled. A focused rerun against fresh disposable PostgreSQL on ports 55493/55494/55497 produced **11/11 PASS** and left the long-lived QA on port 55495 untouched. The updated four-container Release Gate step still requires its own GitHub CI result before merge.
