# Vendor Invoice/AP source-parity review — 2026-11-16

**Canonical target:** `bizportal/bizportal-app` (Draft PR #95). **Legacy:** `Travelintrips/CST-BIZPORTAL`.

## Verified differences

- Both repositories derive vendor invoice paid amount from reconciled payment allocations. The canonical detail route remains scoped by `vi.id` and `vi.company_id`. A source-only regression test now protects these existing behaviors.
- Legacy `purchase-workflow.ts` exposes informational orphan-disbursement evidence (original invoice missing, exact invoice reference and amount, posted payment plus reversal). Canonical currently does not include the orphaned disbursement evidence field.
- Legacy also exposes reversed/voided payment references and related UI warnings. Canonical lacks those response fields and warnings. **Neither orphaned nor reversed evidence should ever increase paid amount**.
- Legacy `bank-reconciliation.ts` has a vendor-invoice component payment route with locking, company scope, replay checks, and journal/allocation/audit transaction guards. Canonical does not currently contain this route. It is a **financial writer**; do not copy it into the canonical environment without dedicated disposable PostgreSQL E2E, schema checks, explicit DEV authorization, and reconciliation idempotency tests.
- Historical read-only evidence and component-payment write routes are distinct features. Keep them separate in any follow-up PR.

## Gate / next change

1. Check table/column presence in DEV: `bank_disbursement_items`, `bank_disbursements`, `accounting_entries` (including reversal and void fields). No DDL or data write during readiness.
2. Port *read-only* historical evidence into a separate scoped change, preserving `reconciled_amount_paid` as the **only** source for `amountPaid`. Use contract and disposable database tests for false-positive matching.
3. Add UI warnings as informational only: not proof of payment, not authorization to issue/void/repost. Disable duplicate payment shortcuts when evidence is unresolved.
4. Treat the component payment route as a later independent writer migration, not a prerequisite to display historical evidence. Require row locking, company RLS, one accounting writer, rollback, and no duplicate journals.
5. Run full release CI and feature tests; require DEV shadow HTTP E2E before any cutover.

**Current PR impact:** documentation and regression test only for Vendor AP; no vendor payment endpoint, invoice mutation, DB change, feature-flag change, or Hostinger/PROD deployment.
