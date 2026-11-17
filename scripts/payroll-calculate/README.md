# Payroll DEV Calculate — staged canary (default OFF)

Reuses the existing `calculateKasbonAutoDeduction` projector, one-stage signed Super Admin approval, immutable accounting writer and existing `payroll_kasbon_auto_{plans,reservations}` tables. No replacement payroll engine, migration, ad-hoc accounting, new human approval, bank transfer, PROD activation, or shared-pool salary writer.

## Scope

- `POST /api/payroll/runs/:id/calculate?companyId=1` with JSON `{}`, authenticated **signed OTP Super Admin**, exact approved HTTPS Origin, and the dedicated role-pinned DEV Payroll connection only
- Available only with `APP_ENV=development` and `PAYROLL_DEV_CALCULATE_ENABLED=true`; other runtime controls and the UI Calculate capability remain OFF by default
- Uses one SERIALIZABLE transaction; checks the database identity, exact column INSERT/UPDATE grants and company scope; locks the Draft run, uses the existing advisory lock, verifies active roster, existing salary arithmetic and cash advances
- Fails on foreign employees, unpaid or invalid source advances with selected plans, missing FULL/INSTALLMENT choices, changed holds, scheduled legacy installments, double deductions or insufficient net salary
- Calculates exact integer cents, persists `payroll_items.kasbon_deduction`/`total_deductions`/`net_salary` plus matching **prepared** reservation rows, validates read-back through the existing approval ledger guard and returns the approval digest
- Leaves `payroll_runs.status='draft'`, `approved_at=NULL`, accounting and payment links empty, kasbon principal unchanged. The existing single signed Super Admin approval moves the run directly from `draft` to `reviewed`
- An explicit PostgreSQL serialization/deadlock abort (`40001` or `40P01`) can retry at most two times **only after successful ROLLBACK**. Ambiguous COMMIT or connectivity failures never auto-replay. Existing reservation uniqueness prevents duplicate preparation.

## Isolated verification

`bash scripts/payroll-calculate/run-disposable.sh` starts a disposable loopback-only PostgreSQL 16 container using fixture-only credentials, synthetic employees/loans and restricted role/RLS. It never connects to GCP or Supabase. The shell trap removes the container after success or failure. Real SQL tests verify installment/FULL, idempotent replay, cross-company denial, transaction rollback under an INSERT trigger fault, role permissions, concurrent requests, changed plan, legacy schedule rejection, and no-loan scenarios.

Other focused tests: `pnpm --filter @workspace/api-server exec vitest run src/routes/payroll-calculate.test.ts src/routes/payroll-calculate-http.test.ts`.

The GitHub Payroll disposable workflow runs the real PostgreSQL Calculate test separately from the legacy native accrual suite. Test counts overlap other regression families and should not be summed into unique acceptance coverage.

## Operational NO-GO

This source-only step is **not** live DEV E2E approval/accounting/payment. The actual DEV Payroll role still needs verified column grants and RLS for this new mutation and legacy schedule checks. Approval and settlement DB roles are NOLOGIN, two GCP secret containers have no credential versions, November salary profiles/deduction settings/plan rows and actual payroll items require authorized setup, and the signed-session → real Calculate → Super Admin approval → atomic native GL/ledger sequence remains unproven.

Do not deploy/enable or change any PROD payroll flags until all live DEV acceptance gates succeed. Never use the shared Finance/OTP/admin database pool or reuse unrelated credentials to bypass restricted roles.
