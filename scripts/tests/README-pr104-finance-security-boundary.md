# PR104 — Finance GUC boundary & reverse lock-order safety gate (test-only, Draft)

## Purpose

This Draft PR targets only the existing Finance Vendor Invoice security review. It does **not** merge or activate PR #81, #101, #102 or #103, and does not install SQL objects on CST-DEV or touch PROD. Preserve all previously successful canonical AP/Accounting and Vendor Invoice PostgreSQL 16/17 tests.

## Confirmed boundaries

1. PostgreSQL allows an ordinary non-superuser database session to set a custom session variable such as `app.marketplace_company_id`. A tenant SELECT RLS rule that evaluates only this variable is **not independently authorized**. `pr104-tenant-boundary.sql` reproduces this **with only synthetic IDs, synthetic role and synthetic data**, no real customer records or DB credentials, then verifies that rollback removes everything.
2. PR #103's private `SECURITY DEFINER` locks PO→Goods Receipt→Shipment. An unrelated writer locking Shipment first and then requesting PO creates a reverse-order lock cycle. The independent PostgreSQL test `pr104-deadlock-e2e.ts` verifies that PostgreSQL detects a real `40P01` and that transaction rollback leaves PO and Shipment unchanged. This test does **not** assert that a deadlock happened in CST-DEV.
3. The existing vendor-token route previously mapped a deadlock or serialization failure to a generic HTTP 500. It now recognizes SQLSTATE `40P01` (deadlock), `40001` (serialization), and `55P03` (lock unavailable) through bounded nested `Error.cause` traversal and responds **503**. It never automatically repeats an invoice write. The existing file cleanup in the POST catch path remains in place; three new route tests prove it deletes an uploaded synthetic proof on all three SQLSTATEs.

## Key security decision still outstanding

The CST-DEV Finance role has RLS policies scoped by `current_setting('app.marketplace_company_id',true)`, and the application currently sets that value on a server-verified transaction. Direct possession of the Finance DB credential, however, is a different trust boundary. A leaked or misused credential could set the tenant variable and read any data allowed by the role's generic RLS policy. The role currently has SELECT access to the PO token column. **This is a design warning, not evidence of compromise.**

Do **not** respond by adding a broad Finance UPDATE/INSERT grant, turning off RLS, switching to the privileged shared pool or removing the signed Super Admin session. Before any Writer enablement, require a security decision on database-enforced tenant identity: e.g. independently restricted company-specific DB credentials/policies or a verified DB-backed scoped authorization assertion that the Finance role itself cannot manufacture. Verify custody, rotation, exposure, and role permissions without reading or printing actual secrets.

## Deadlock handling requirement

Choose and enforce one PO/GR/Shipment row-lock order across every lifecycle writer before deployment. Preserve PostgreSQL deadlock rollback, **no automatic invoice replay**, bounded request handling, and the existing uploaded-proof cleanup when the transaction aborts. A 503 is retryable by the client or later explicit re-submission after verifying invoice state; it is not proof of a completed payment/invoice.

## Evidence & constraints

- PostgreSQL 16 isolated test PASS locally, zero production data or credentials, `--network none` or a private internal Docker bridge, no host DB mounts.
- GitHub CI also tests PostgreSQL 17, matching CST-DEV's major DB engine version. Do not claim PG17 PASS until exact-head GitHub CI completes.
- CST-DEV remains read-only from this audit: **18 Finance RLS policies**, no direct PO/GR/Shipment UPDATE for Finance, 10 historical CST/Diva Vendor Invoices, no new private lock function or owner role installed.
- No independent release approval or signed HTTPS vendor-upload E2E has occurred. All PRs remain Draft, flags OFF, PROD untouched.
