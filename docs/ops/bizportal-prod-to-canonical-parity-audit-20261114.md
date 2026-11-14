# BizPortal PROD → canonical repository: selective parity audit

**Status: CUTOVER BLOCKED — PROD SOURCE MUST BE PRESERVED.** Read-only GitHub source inspection on 14 Nov 2026. The Hostinger PROD app was evidenced by hPanel to use Travelintrips/main deployed short SHA `647f2778` (2026-11-14 20:42 WIB). Legacy GitHub SHA `647f27786dedcadc6392a37ff2c03b7c81e843bc` matched that abbreviation. This does **not** independently establish current running-process provenance.

## Compared repositories / exact heads
- **Legacy Hostinger source:** `Travelintrips/CST-BIZPORTAL` at `647f27786dedcadc6392a37ff2c03b7c81e843bc`.
- **Canonical target:** `bizportal/bizportal-app` at `23a85bd1f6bb9a57b75dec4e5c0dc08fe8eb75ee`.
- This is an **inventory and source registration** comparison. No behavioral tests, user authentication, external services or production deployments were performed here.
- Counts refer only to top-level paths under `artifacts/api-server/src/routes/` and `artifacts/bizportal/src/pages/` (exclude `.upstream-cst-super-app` nested snapshot).
- Legacy API route directory: **98 files**; canonical: **51 files**; 43 matching relative filenames, 55 present only in legacy, 8 only in canonical.
- Legacy UI pages directory: **387 files**; canonical: **373 files**; 14 present only in legacy. These counts are NOT counts of functional endpoints nor a measure of feature parity.

## Concrete, confirmed source registration differences

| Workstream | Legacy source | Canonical source | Risk | Correct next evidence |
|---|---|---|---|---|
| Payroll PROD | `payroll.ts` registers `registerProdPayrollDraftRoutes`, `registerPayrollProdConnectionPreflightRoutes` | These registrations absent from canonical `payroll.ts`; old registration files absent | **BLOCKER**: opt-in PROD draft/preflight behavior might be lost | Match feature flags, auth, company isolation, state machine and HTTP behavior in disposable DEV; preserve existing PROD defaults |
| Payroll Kasbon | `payroll.ts` registers `registerPayrollKasbonAutoRoutes`; module in legacy | Registration and module absent from canonical | **BLOCKER**: automated kasbon deduction paths may regress | Compare contract and tests with production-like fixtures; do not create/settle real advances |
| Payroll approvals/review | Legacy registers Super Admin approval, standalone components, effective setup preview, historical salary review | Registrations absent from canonical `payroll.ts`; several modules absent | **BLOCKER**: approval and salary review parity not proven | Owner scoped authorization and signed-session tests, UI action inventory |
| HRD OCR/photo | Legacy includes `hrd-document-ocr.ts`, `hrd-ocr-routes.ts`, `hrd-photo-routes.ts`, `hrd-photo-storage.ts` | These paths absent from canonical; canonical has gated/read-only readiness modules | **BLOCKER**: private upload/OCR lifecycle parity unproven | Check default-off flags, private storage, OCR, camera/photo flows in approved DEV only |
| HRD directory UI | Legacy `artifacts/bizportal/src/pages/hr/employee-directory.tsx` and `employee-detail.tsx` | Both files absent in canonical at inspected head | **BLOCKER**: verified UI workflow may regress | Compare routing / screen behavior in DEV with existing PROD, no PROD employee changes |
| Sport Center group allocation | Legacy `routes/index.ts` mounts `group-payment-allocations.ts`, DEV-only POST `/sport-center/group-payments/:paymentId/allocate` | Module and mount absent in canonical | DEV-only parity gap, not evidence of active PROD gap | Validate whether this workflow is still required; never expose it to PROD by default |
| QRIS #292 | Canonical has isolated PostgreSQL correction tests, source-only guard migration and route inactive | Live PROD still requires separately approved scoped SQL migration | Distinct financial release blocker | Retain Draft, immutable original journal, isolated E2E and explicit approval |
| Invoice/AP/reconciliation | Both repos have some matching module paths | No deep semantic parity verified yet | **UNVERIFIED** | Compare route contracts, accounting side effects, idempotency and UI workflows before cutover |

## Explicit invariants

1. **Do not substitute new implementations for legacy PASS behavior.** Port only missing source components with original authorizations, feature flags and tests, then prove parity.
2. Preserve original legacy Hostinger deployed version and rollback method. No source switch on GitHub CI alone.
3. Do not modify LIVE PROD employee, kasbon, accounting, QRIS or bank transaction rows as part of parity testing.
4. A file missing in canonical does not prove a missing *endpoint*. Conversely, CI PASS does not prove production-equivalent behavior. Verify the actual registration and HTTP response before marking PASS.
5. Keep `bizportal/bizportal-app` as canonical target repository. Do not deploy mirror or legacy repository to replace the target during migration.
6. Treat QRIS #5738 financial reversal and PROD trigger migration as separate change controls and permissions.

## Required cutover sign-off

- [ ] Actual Hostinger runtime repo, branch and deployed full SHA checked from hPanel AND active application artifact.
- [ ] Disk/inode/CPU/RAM headroom confirmed after operator reported hosting-full warning cleared.
- [ ] Payroll PROD, automatic kasbon, salary review and approvals parity proven in DEV.
- [ ] HRD OCR/photo and directory UI parity proven in DEV.
- [ ] Accounting, QRIS, Invoice/AP and bank reconciliation behavioral parity proven in DEV.
- [ ] Auth/tenant isolation and current signed sessions preserved.
- [ ] Previous Hostinger deployment rollback rehearsed with no financial-row restore.
- [ ] Separate owner approval explicitly authorizes source cutover. **Not currently granted.**

**Verdict:** NO HOSTINGER CUTOVER. This document records source evidence, not a request to disable, delete or reimplement functionality.
