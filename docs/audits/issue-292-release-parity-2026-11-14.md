# Issue #292 — BizPortal release-source parity audit (14 Nov 2026)

**Status: BLOCKED for code promotion.** This is a source-parity document, NOT a
financial correction, migration, or deployment instruction.

## Confirmed repository identities

- **Approved release repository:** `bizportal/bizportal-app` (this repository).
- **Development evidence:** `Travelintrips/CST-BIZPORTAL` Draft PR #296
  (historical QRIS Batch #5738 correction).
- **Excluded:** `Travelintrips/bizportal-hostinger-mirror`; do not use as a
  deployment source.
- **Hostinger runtime commit / checkout:** not independently verified via
  authenticated Hostinger runtime. A repository selected by the owner does not
  by itself prove the deployed filesystem/commit.

## Audited source gap

This repository states in `MIGRATION_NOTES.md` that it originated from the
16 October 2026 source snapshot `cd9a94dc39be3322248ddc53ca2bd0b5e53134db`,
using a new Git history.

On 14 November the `main` tree here did **not** contain the following
required finance correction components from development PR #296:

- `artifacts/api-server/src/lib/reconciliation/canonicalSettlementCorrection.ts`
- `artifacts/api-server/src/lib/reconciliation/canonicalSettlementCorrectionCoordinator.ts`
- `artifacts/api-server/src/lib/reconciliation/issue292OwnerRuleGate.ts`
- `artifacts/api-server/src/lib/reconciliation/issue292FinancePrincipalGate.ts`
- `scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql`
- `.github/workflows/qris292-isolated-postgres.yml`

`artifacts/api-server/src/routes/bank-reconciliation.ts` is present, but
differs from development. It must be reconciled *semantically* with the active
release implementation; do not replace the entire file or infer ancestry from
an unrelated Git history.

## Isolated development evidence (NOT a PROD result)

- Historical-like #5738 posted reversal + replacement batches for 4/5 Nov +
  both canonical bank approvals in **one transaction**: GitHub Actions
  `43593115383` PASS at SHA `758037e7`.
- Extended source-journal debit/credit, source-payment receipt preservation,
  superseded historical match and rollback assertions:
  `43593388128` PASS at SHA `c4181d77`.
- Net across the two bank cohorts: Rp1,609,500.
- All tests use disposable PostgreSQL synthetic fixture and rollback.
- The development finance PR remains DRAFT; no historical financial PROD
  correction is approved by this audit.

## Promotion prerequisites (all required)

1. Obtain a **read-only, authoritative Hostinger runtime provenance**
   showing deployed repository remote, exact commit SHA, branch, build artifact,
   deployment source and rollout mechanism. Do not print secrets.
2. Compare that release baseline with this repository, then compare complete
   finance route dependencies, database schema/guard migration history,
   permission boundaries, and downstream API contracts to PR #296.
3. Bring across **only** isolated, behaviorally compatible changes via a
   separate Draft PR on this repository. Never overwrite working Payroll,
   HRD, reconciliation, bank sheet, or finance functions with old snapshots.
4. Add target-repository parity tests (API/build, existing reconciliation CI,
   4/5 Nov owner-builder and reversal E2E, duplicate approval/idempotency,
   wrong bank/date/COA, audit durability, atomic failure rollback).
5. Obtain an explicit manual journal debit/credit review and separate release
   authorization **after** all gates pass. Production financial reversal is a
   distinct, later, auditable operation.

## Hard safety boundaries

- Do **not** merge this audit into `main` merely because generic CI passes.
- Do **not** apply the guard migration to PROD, alter source payment dates,
  approve match #14449, mutate financial tables, or change Hostinger.
- Do **not** use `git push --force`, whole-directory copy, or history reset
  to reconcile repositories.
- **Fail closed** when any dependency, runtime provenance, or guard cannot be
  verified. Preserve every existing PASS behavior.

## Automated target-repository inventory (14 Nov)

Run `node scripts/audit-qris292-release-parity.mjs` from repository root.
Use `--fail-on-blocked` in a future release-preflight pipeline to return
exit code 2 when dependencies remain absent. The dedicated audit workflow
checks that the report is internally consistent; **a green inventory workflow
never means a release is authorized.**

The standalone PostgreSQL `bigint` canonical approval comparison fix has been
prepared separately in [Draft PR #25](https://github.com/bizportal/bizportal-app/pull/25)
and its Reconciliation CI and Release Gate passed. It is **not merged** and is
not a substitute for the full #5738 reversal and owner-builder dependency port.
