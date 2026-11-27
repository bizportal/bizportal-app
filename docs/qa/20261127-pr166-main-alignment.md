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
