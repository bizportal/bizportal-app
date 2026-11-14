# HRD Stage 2 — Resign/Kasbon precheck (read-only only)

Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40). Depends on Stage 1 PR #47.

## Preserved contract from existing PROD
- Adds only `GET /api/hrd/employees/:id/resign-kasbon-precheck?companyId=N`, behind both `HRD_CANONICAL_READONLY_ENABLED=true` and a *separate* `HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED=true` flag. Both are OFF unless explicitly enabled.
- Reuses verified HRD production session and active-account gate, designated CST Owner/Super Admin authorization, and `BEGIN READ ONLY; SET LOCAL ROLE bizportal_hrd_prod;` transaction-local company scope.
- Requires a real employee in the scoped company before calling `hrd_private.employee_resign_kasbon_precheck(companyId, employeeId)`.
- Returns separate unverified, verified unsettled, and reserved payroll counts/balances; `canDeactivate` is false if *any* unresolved item exists.
- No employee status PATCH, no direct financial settlement, no payroll reservation or deduction, no accounting writes.

## Database evidence and security nuance
The existing Supabase PROD precheck function is **SECURITY DEFINER** owned by postgres. Its definition explicitly validates `app.hrd_company_id` against `p_company_id`, rejects missing/invalid employees, filters all source tables on company/employee, and only computes aggregate counts. EXECUTE is granted to `bizportal_hrd_prod`, not `anon`/`authenticated`. This must not be generalized or granted to public roles.

A direct `BEGIN READ ONLY` query in Supabase PROD using `bizportal_hrd_prod` for employee 38 returned two unverified historical kasbon totalling Rp16,000,000, zero verified unsettled kasbon and zero active payroll reservations. The existing business rule blocks deactivation pending source verification; **the recorded amount is not proof of a verified debt**.

## Release criteria
1. Isolated HTTP tests must pass including disabled flag, owner/tenant checks, employee ID, error redaction, no writes.
2. GitHub CI/test/typecheck/build PASS and code/security review with no unresolved findings.
3. Keep all HRD deployment flags OFF, don't migrate or alter database privileges.
4. Hostinger source cutover remains BLOCKED by Issue #40 until Payroll, OCR, HRD status, and finance allocation parity are proven.
