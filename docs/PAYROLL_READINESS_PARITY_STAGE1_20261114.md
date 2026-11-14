# Payroll PROD readiness parity — Stage 1 (aggregate only)
Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40).

## Source basis
Port only the existing PROD `/payroll/setup-readiness` aggregate endpoint from `Travelintrips/CST-BIZPORTAL` into canonical `bizportal/bizportal-app`. It checks active employee counts and whether effective-dated salary and five deduction codes are configured for the selected year and month. It does not return employee names, salaries, or per-employee deductions.

## Security and runtime restrictions
- Mounted **after** the existing `router.use("/payroll", authorize)` middleware; company scope is resolved from the verified BizPortal session, not directly from untrusted query parameters.
- Available only for Owner or Super Admin in production, and only when `PAYROLL_CANONICAL_SETUP_READINESS_ENABLED=true`. Flag defaults OFF (404).
- Uses existing `payroll-prod-db.ts` role-scoped read-only connection; no `payroll-db.ts` PROD shared-pool fallback.
- No action to create draft, apply setup, approve salary, pay payroll, settle kasbon or post accounting.
- Preserves source's rules for `effectiveThrough`, five required deduction codes, nonnegative values, and disabled financial capabilities in the response.

## Validation before merge or rollout
1. CI API tests and BizPortal tests, Typecheck, build, runtime smoke all PASS.
2. Review company-tenant scope, role check, 404 when disabled, no individual salary data in response, 503 with redacted DB error.
3. Check Supabase role privileges and a read-only query without mutating any data.
4. Do not enable flag or change Hostinger source, while Issue #40 remains BLOCKED.

This is the first Payroll readiness read-only slice; it does **not** establish parity for draft creation, salary changes, approval, payment, GL, HRD, or automatic kasbon deduction. 
