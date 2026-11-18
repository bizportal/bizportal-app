# CST Customer Invoice — dormant scoped writer stage (DEV only)

Status: **Phase A and Phase A2 deployed to Supabase CST-DEV, and verified.
Not a login or posting release.** Date: 18 November 2026.

## Scope and immutable boundaries

- Target Supabase project **`xssrfshdrtdfupgqwfdw`** only.
- Never run these scripts against PROD project `nzdweipzckfszczzqtuw`.
- No app release, original Accounting engine replacement, login credential,
  Secret Manager payload, RLS policy, table write privilege or financial data
  was created at these phases.
- Customer Portal live release remains `577aa54`; five Invoice/PPN/AR/outbox
  feature flags stayed OFF, and Portal/BizPortal DEV ready probes returned 200.

## Applied changes

1. Supabase migration `dev_customer_invoice_dormant_scoped_writer_roles_20261118`
   from `scripts/sql/customer_invoice_scoped_writer_dormant_cst_dev.sql`.
   Created two disabled **NOLOGIN, NOINHERIT, NOBYPASSRLS**, non-superuser,
   non-CREATEROLE identities:
   - `bizportal_customer_invoice_cst_writer_dev` (intended company ID 1)
   - `bizportal_customer_invoice_diva_writer_dev` (intended company ID 3)
2. Migration `dev_customer_invoice_dormant_ar_source_actors_20261118`
   from `scripts/sql/customer_invoice_dormant_ar_actor_staging_cst_dev.sql`.
   Reserved the two company-specific rows in the **existing** canonical
   `public.bizportal_customer_ar_source_actors_dev`, each `enabled=false`.
   The count of existing enabled source actors stayed **2**.

Postcondition query confirmed both roles `rolcanlogin=false`,
`rolbypassrls=false`, and no INSERT privileges on
`sales_documents`, `accounting_entries`, `transaction_taxes`,
`financial_outbox_events`; no UPDATE privilege on `users`. No
`QA-OWNER-SCOPED-` sales document was present.

## Hosted PostgreSQL 17 creator edge

Supabase's managed `postgres` CREATEROLE path automatically creates
a `pg_auth_members` entry **to `postgres`** for each newly created role,
with `admin_option=true`, `inherit_option=false`,
`set_option=false`, grantor `supabase_admin`.

This is a management entry, **not** an authorized writer login, inherited
table privilege or `SET ROLE` capability. Do not mistake its presence for a
functional invoice posting session; do not grant `postgres` membership
in `supabase_admin`.

The role rollback SQL explicitly permits *only* that exact creator edge
and rejects any extra membership, LOGIN or BYPASSRLS state.

## Verified rollback order (only before activating any writer)

1. Check both actor rows are still `enabled=false`, and both role identities
   remain `NOLOGIN` with no table grants/policies added.
2. Apply `scripts/sql/customer_invoice_dormant_ar_actor_rollback_cst_dev.sql`
   first; it removes only the exact disabled Phase A2 rows.
3. Apply `scripts/sql/customer_invoice_scoped_writer_dormant_rollback_cst_dev.sql`
   second; it rejects active/privileged roles and unexpected memberships,
   and `DROP ROLE` has **no CASCADE**.

PostgreSQL16 disposable create/verify/rollback was tested with a synthetic
ADMIN-only creator grant (no SET/INHERIT), exit 0. The AR actor stage/rollback
test preserved the original enabled actor count (2).

**Never run these rollback scripts after further grants, policies or
credentials are installed without a new review.**

## Unfinished release gates

- Review actual CST-DEV table/column grants and per-company RLS for the two
  roles. BizPortal [PR150](https://github.com/bizportal/bizportal-app/pull/150)
  contains real direct-login PostgreSQL16 disposable proof under those
  identities; its QA fixture is not a hosted migration.
- Configure independent writer credentials and verified TLS/CA through an
  approved **DEV-only Secret Manager** chain. Do not use `postgres` or
  shared Finance readers as a fallback, and never print/store passwords in PR.
- Activate direct LOGIN only when the scoped writer grants/RLS and secure
  secret custody are ready, then test the exact direct Session Pooler 5432
  host/project/user with real `CURRENT_USER=SESSION_USER`, no BYPASSRLS.
- Reuse approved, independently reviewed Portal company affiliation (currently
  none for the two Admins) via the existing PR213/PR221 request/review path.
  Do not self-approve or create approval rows from SQL for a passing test.
- Run original Super Admin signed OTP HTTPS flow and end-to-end Invoice:
  real original Accounting GL + 11% PPN (where applicable) + AR + ledger
  audit/outbox after COMMIT, idempotent replay, error rollback and cross-company
  denial; all DEV, with no WA/email/payment dispatch.
- Only after exact-head CI, browser and DB evidence PASS should an isolated
  DEV deployment be reviewed. PROD cutover is separate and unapproved.

Tracked in [BizPortal Issue #149](https://github.com/bizportal/bizportal-app/issues/149),
[Customer Portal PR221](https://github.com/Travelintrips/CST-CUSTOMER-PORTAL/pull/221),
and [BizPortal PR150](https://github.com/bizportal/bizportal-app/pull/150).
