# Hostinger PROD Cutover: Source Parity Baseline (2026-11-14)

**Decision: CUTOVER BLOCKED.** This document is a source-level inventory. It is not an assertion that a file existing (or missing) proves behavioral parity, nor a request to deploy or change production financial controls.

## Baselines verified
- Existing Hostinger PROD `bizportal.cstlogistic.co.id`: hPanel showed repo `Travelintrips/CST-BIZPORTAL`, branch `main`, commit `647f27786dedcadc6392a37ff2c03b7c81e843bc`. Hostinger asset inspection showed deployment-generated frontend bundles; it did **not** prove parity with canonical.
- Canonical repository: `bizportal/bizportal-app@8331aae4a0027cc3516aa26085fed327b55774b9`, containing merged Kasbon PR #32. GitHub Release Gate PASS.
- Git tree comparison: legacy 5,219 paths; canonical 889 paths. Many legacy paths are build/test or non-runtime files; counts alone do not establish feature loss.

## Source-preflight result on canonical baseline
The 16 explicit source checks currently report **4 PRESENT / 12 MISSING** (static code evidence only). The four present contracts are the scoped historical kasbon API, its role-scoped PROD reader, the unverified balance UI label, and the read-only Rule AI preview route. The absent checks cover HRD, Payroll PROD extensions, and group allocations. **Even 16/16 PRESENT would not prove runtime behavioral parity.**

## Confirmed source-level gaps (not yet behaviorally verified)
| Area | Existing legacy entrypoint/module | Canonical status | Impact to prove |
| --- | --- | --- | --- |
| HRD | `routes/index.ts` mounts `hrd-routes.ts` | No corresponding mount | Employee status/resign, OCR/documents, permissions |
| Finance allocation | `routes/index.ts` mounts `group-payment-allocations.ts` | No corresponding mount | Existing group payment and idempotence |
| Payroll | `routes/payroll.ts` registers eight extension modules | Not registered | Salary setup/readiness, historical review, automatic kasbon, one Super Admin approval, gated PROD draft |
| Payroll UI | `hr/PayrollProdRunControls.tsx` | Not present | Existing controls and permission state |
| Purchase | Legacy has additional vendor invoice mutation/read endpoints | Several paths not present | Real workflow contract and financial authorizations |
| Reconciliation | Both define Preview Rule AI, differing code | Requires behavioral test | Preview safety, company scoping, no writes |
| Kasbon | GET-only reader + scoped PostgreSQL role | Present via PR #32 | Authenticated Owner UI response and deployment still unproven |

## Dependency audit and safe workstream order
1. **HRD read-only parity first:** Legacy `hrd-routes.ts` imports `hrd-access`, `hrd-db`, employee status, photo/OCR routes, document OCR and storage canary. This is a dependency cluster, **not a single file copy**. Inspect each existing PROD authority/RLS rule, then stage only read-only readiness and employee queries in isolation; test other-company 403 and denied writes.
2. **HRD resign/kasbon precheck second:** Preserve blocking/exception semantics and prove no automatic mutation of an unverified kasbon.
3. **Payroll PROD gated parity next:** Restore only tested readiness and Super Admin approval controls behind the existing backend authorizations. The modules referenced by legacy payroll register eight extensions and include potential financial write paths. Do not register draft, approval, payment or journal writers merely to make the interface appear complete.
4. **Group allocations later:** Legacy `group-payment-allocations.ts` provides `POST /sport-center/group-payments/:paymentId/allocate` (a financial writer). Never copy/mount or activate without standalone idempotence, allocation, permissions and rollback evidence.
5. **Recon/Purchase regression checks:** Both repositories define the Rule AI preview route, but code differs; preserve read-only behavior and check invoice/payment mutation contracts before cutover.

These stages are proposed source parity workstreams. They do not claim the production features have been behaviorally re-verified.

## Evidence already established for kasbon
A limited `BEGIN READ ONLY; SET LOCAL ROLE bizportal_payroll_prod` query against Supabase PROD showed 23 CST historical records, with Andi (employee 38) holding two historical records totaling Rp16,000,000 **recorded and not yet verified for approval/disbursement/accounting**. A company-2 RLS scope returned zero CST rows. No financial writes were executed.

## Repeatable source preflight
Run from the repository root:

```bash
node scripts/audit-prod-parity.mjs
node scripts/audit-prod-parity.mjs --json
node scripts/audit-prod-parity.mjs --strict
```

The script reads repository files only; the default report does not fail CI. Strict mode exits nonzero when evidence markers are missing. The checks are deliberately **necessary source-level signposts, not sufficient proof of behavioral equivalence**. If implementation names change in an approved refactor, update the manifest with equivalent grounded evidence and specific regression tests.

## Conditions before cutover
1. Capture hPanel repository/branch, working deployed artifact fingerprint, build settings, environment variable **names only**, logs, and a reversible rollback procedure. Resolve Hostinger 100% resource warning before a new build.
2. Bring each missing PROD-PASS behavior into canonical through small isolated PRs. No wholesale rebuild, no direct import of privileged financial writers, and no accidental change from PROD behavior to DEV behavior.
3. Run comprehensive DEV CI and behavioral parity tests: HRD company isolation, resign with open kasbon, OCR/private files; Payroll owner approval and kasbon deduction gate; group payment allocations; Finance Rule AI preview and reconciliation. DEV should never reach live PROD WhatsApp/Sheets/X904.
4. Demonstrate authenticated Owner `GET /api/advances?companyId=1` and dashboard returns correct historical rows, with unverified balances clearly distinguished from verified debts.
5. Only after approvals and complete evidence, perform a controlled Hostinger source switch, verify smoke tests and rollback ability. Keep production financial writes disabled until separately authorized.

Tracking: [Issue #40](https://github.com/bizportal/bizportal-app/issues/40). No Hostinger, database, payroll, kasbon, or journal changes are performed by this audit.
