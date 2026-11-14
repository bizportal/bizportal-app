# HRD source parity: Stage 1 read-only directory
Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40).

## Scope deliberately retained from existing PROD code
- Production BizPortal session, fresh public.users active account check, designated CST Owner DB identity / Super Admin scope from legacy `hrd-access.ts`.
- Same employee directory columns and predicates from legacy `hrd-routes.ts`: company_id, deleted_at, 500-row cap.
- Existing `bizportal_hrd_prod` role and `app.hrd_company_id` transaction-local RLS scope.
- New dedicated `BEGIN READ ONLY` wrapper, with database role/scope verification and rollback on failures.
- `GET /api/hrd/readiness?companyId=N` and `GET /api/hrd/employees?companyId=N` only.

## Strictly out of scope
No `/hrd/employees/:id` document-profile detail, OCR, photo upload, private storage access, resign/status changes, employee writes, kasbon settlement, Payroll actions or payment. These **remain missing** from canonical and are separate future parity stages. This is *not* full HRD parity.

## Runtime gate
`HRD_CANONICAL_READONLY_ENABLED` must be exactly `true` and `APP_ENV` exactly `production` (after trim/case normalization). The feature defaults to 404. This new gate is independent from existing legacy `HRD_PROD_ENABLED`; do not enable it on Hostinger until deployment source and authorized Owner checks have been proven in a controlled environment.

## Test and release criteria
1. API integration tests verify missing/disabled session, inactive user, role mismatch, cross-company denial, designated CST Owner, scoped Super Admin and secret-redacted failures.
2. Database-helper tests prove READ ONLY, SET LOCAL ROLE, correct scope, rollback on invalid role/tenant/query error.
3. GitHub Release Gate must PASS before any merge consideration. No PROD database migrations required by this source slice.
4. Verify independent role RLS permissions and query shape on PROD using read-only sessions; no live private document reads are needed.
5. Do not switch Hostinger repository until all issue #40 blockers, including Payroll and payment allocation behavioral parity, are resolved.

## Safe rollback
Keep source branch unmerged and feature flag OFF. The current Hostinger PROD deployment from `Travelintrips/CST-BIZPORTAL` remains untouched, and no financial or HRD record is written during this development stage.
