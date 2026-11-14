# BizPortal Hostinger source cutover — read-only readiness

**Status: BLOCKED / DO NOT CUT OVER.** Prepared 2026-11-14 for `bizportal/bizportal-app`. This is an operator checklist, **not** authorization to switch Hostinger source, deploy, update PROD database functions, or execute QRIS #292.

## Evidence from GitHub (not Hostinger)
- Designated canonical GitHub repository: `bizportal/bizportal-app`.
- Source repository that earlier hPanel evidence identified: `Travelintrips/CST-BIZPORTAL` on `main`; this is **historical evidence**, not a current live attestation.
- At last inspection, legacy repository `main` was `647f27786dedcadc6392a37ff2c03b7c81e843bc` and canonical `main` was `524be5a23918b64594369594c2e2ec3bde1fd9e5`. Do **not** infer a deployed SHA from GitHub heads.
- Canonical `main` has active ruleset `Protect Main - BizPortal PROD`, requiring a PR and strict required check `Test, typecheck, build`.
- QRIS #292 test-only code was merged through PR #42; current bank route still does **not** invoke the historical correction writer. Proposed scoped trigger migration is source-only.
- PR #45 remains Draft and only hardens source-level CI invariants; PR #30 remains Draft.

## Read-only Hostinger hPanel verification (operator, no secrets)
1. In the existing **BizPortal PROD** Website / Node.js application (not Customer Portal VPS or BizPortal DEV), capture its website/app identifier and deployed domain.
2. Read the connected **Git repository owner/name, branch, latest deployed commit SHA, deployment timestamp and last result** from hPanel.
3. Record whether automatic deployment on Git push is enabled. Do **not** toggle or reconnect it.
4. Independently check active Node.js process or hPanel deployment directory and confirm the running application corresponds to the displayed deployment entry. If a deployed checkout is accessible, use `node scripts/hostinger-runtime-attestation-readonly.mjs` from that directory **only with read permission**; if no checkout is present, record `NO_GIT_METADATA` rather than guessing the SHA.
5. Redact any tokens, SSH details, environment variables, database URLs, authorization headers and secrets before sharing logs or screenshots. Do not run commands which print secrets.

**Acceptance:** repository, branch, deployed full SHA, timestamp, live process directory/bundle hash and auto-deploy state are mutually consistent and independently verified. Otherwise **BLOCKED**.

## Functional parity before any source switch
- Compare existing PROD's working behavior against canonical candidate in **DEV**: accounting/GL, QRIS, bank reconciliation/Rule AI, vendor AP + customer invoices, Payroll, Kasbon, HRD, authentication and company isolation.
- Verify existing booking/payment integrations only through approved safe DEV fixtures; do not originate real transactions for a test.
- Record actual deployed PROD SHA and candidate SHA, build artifacts, backup/recovery plan, deployment owner and explicit cutover approval.
- Ensure rollback returns application source/bundle and routing to the previously verified SHA **without rolling back or overwriting transactions**.
- No cutover on partial CI alone; do not overwrite the live Hostinger source with the canonical repository without behavioral parity.

## QRIS Batch #5738: separate financial change control
- A source-only migration would permit **only settlement #5738 / original posted journal #7207** to mark membership `active -> reversed`, after balanced posted compensation. Its CI uses disposable PostgreSQL and always rollback.
- Live PROD strict guard is still unchanged; original batch `posted`, four active items, zero reversing journals and zero approved matches as last checked read-only.
- Require a separate explicitly authorized PROD migration with attested rollback, finance-role identity, exact historical preflight and independent accounting review. A Hostinger code cutover does **not** authorize this.
- Do **not** execute the migration, journal compensation, or both bank approvals as part of application deploy.

## Evidence fields to fill after real hPanel verification
| Field | Value |
|---|---|
| Hostinger website/app identifier | NOT VERIFIED |
| BizPortal PROD domain | NOT VERIFIED |
| Connected Git repository | NOT CURRENTLY VERIFIED |
| Connected branch | NOT CURRENTLY VERIFIED |
| Actual deployed full SHA | NOT VERIFIED |
| Deployment timestamp/result | NOT VERIFIED |
| Auto-deploy status | NOT CURRENTLY VERIFIED |
| Active runtime process/bundle fingerprint | NOT VERIFIED |
| Candidate canonical full SHA | Confirm from GitHub immediately before any cutover |
| DEV behavioral parity + rollback exercise | NOT COMPLETED |
| Owner change approval | NOT GIVEN |

The above missing evidence must remain missing until verified. No automatic fallback to historical hPanel values.
