# CST Customer Invoice — dormant scoped writer stage (DEV only)

Status: **Phases A, A2, B1, B2, B3 and B4 applied and read-back verified on Supabase CST-DEV. Both writers remain NOLOGIN, AR actors disabled, and Invoice posting OFF.** Dates: 18–19 November 2026.

## Scope and immutable boundaries

- Target Supabase project **`xssrfshdrtdfupgqwfdw`** only.
- Never run these scripts against PROD project `nzdweipzckfszczzqtuw`.
- No app release, original Accounting engine replacement, login credential,
  Secret Manager payload or financial data was created. B1/B2 added scoped
  SELECT/RLS; B3 added no-mutation FOR SHARE permissions; B4 added
  narrowly source-bound **financial INSERT/UPDATE grants and 40 RLS policies**
  **only to the two dormant NOLOGIN roles**. Drizzle's explicit DEFAULT
  columns require table-level INSERT on original GL headers/lines, contained
  by source/company/account/money RLS. Current Portal cannot use these roles.
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
3. Phase B1 migration `dev_customer_invoice_scoped_writer_read_rls_b1_20261118`
   from `scripts/sql/customer_invoice_scoped_writer_read_phase_b1_cst_dev.sql`:
   68 policies (34 permissive SELECT + 34 restrictive ALL) across 17
   finance/source tables, for direct company1/CST versus company3/Diva only.
   Both NOLOGIN roles may READ own Invoice, original GL/lines/AR, output tax,
   ledger, outbox, audit and settings. **No INSERT/UPDATE** added by B1.
4. Phase B2 migration `dev_customer_invoice_scoped_identity_read_rls_b2_20261118`
   from `scripts/sql/customer_invoice_scoped_identity_read_phase_b2_cst_dev.sql`:
   16 policies across users, Portal customers, active members and reviewed
   company applications. Column-only SELECT excludes password hashes and
   reset tokens; only active Super Admin and independently approved company
   affiliation are visible to the corresponding company role.
5. Phase B3 migration `dev_customer_invoice_scoped_auth_rowlocks_b3_20261118`
   from `scripts/sql/customer_invoice_scoped_auth_lock_phase_b3_cst_dev.sql`:
   eight UPDATE/row-lock policies with **WITH CHECK(false)** and grants to
   a single metadata timestamp column in each auth table. This supports
   PostgreSQL `SELECT ... FOR SHARE` to protect issuer/reviewer/approval
   evidence until COMMIT, but **forbids actual UPDATE**.
6. B4 migration `dev_customer_invoice_scoped_writer_b4_dormant_20261118`
   from `scripts/sql/customer_invoice_scoped_writer_b4_dormant_cst_dev.sql`:
   **40 new policies on 11 financial/Portal audit tables** plus source-bound
   INSERT/UPDATE and exact sequence grants. Its SQL guard requires both
   roles NOLOGIN, AR actors disabled, and B1=68/B2=16/B3=8.
   Original Accounting GL draft/posting, output PPN, AR projection,
   ledger/outbox/audit and Portal notification operations are restricted to
   company1 CST or company3 Diva. There is no global journal writer
   and no trigger replacement.

Latest live read-back: **B1=68, B2=16, B3=8, B4=40 (132 total)**.
Both writers remain NOLOGIN/NOINHERIT/NOBYPASSRLS, cannot SET ROLE postgres
and have no ability to UPDATE original Invoice source amounts, user role,
or read password hashes. The two newly registered AR actors remain
`enabled=false`; preexisting enabled AR actor count remains **2**.
The B4 policies target the two Invoice roles only: no new grants for
`anon`, `authenticated`, Finance, Fleet or Payroll.
The current Portal five financial flags remain OFF.
No `QA-OWNER-SCOPED-` sales document was added to hosted DEV.

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

1. Confirm both roles remain `NOLOGIN`, AR actors `enabled=false`,
   no independent DEV writer credential has been installed, and B1/B2/B3/B4
   counts are exactly **68/16/8/40**.
2. Roll back **B4 first**, using
   `scripts/sql/customer_invoice_scoped_writer_b4_rollback_cst_dev.sql`.
   It refuses active role or AR actor and removes only B4 grants/policies
   (no deletion of existing financial records).
3. Roll back B3 using
   `scripts/sql/customer_invoice_scoped_auth_lock_phase_b3_rollback_cst_dev.sql`.
4. Roll back B2 using
   `scripts/sql/customer_invoice_scoped_identity_read_phase_b2_rollback_cst_dev.sql`.
5. Roll back B1 using
   `scripts/sql/customer_invoice_scoped_writer_read_phase_b1_rollback_cst_dev.sql`.
6. Remove only the disabled Phase A2 actors via
   `scripts/sql/customer_invoice_dormant_ar_actor_rollback_cst_dev.sql`.
7. Finally drop dormant roles using
   `scripts/sql/customer_invoice_scoped_writer_dormant_rollback_cst_dev.sql`,
   without CASCADE. **Do not reverse this order.**

PostgreSQL16 disposable create/verify/rollback was tested with a synthetic
ADMIN-only creator grant (no SET/INHERIT), exit 0. The AR actor stage/rollback
test preserved the original enabled actor count (2).

**Never run these rollback scripts after further grants, policies or
credentials are installed without a new review.**

## Unfinished release gates

- **B1–B4 source, authorization, write grants and role-scoped policies are
  completed on hosted CST-DEV, deliberately dormant.** Original SHA-pinned
  CanonicalPostingEngine B4 PG16 acceptance under both company role identities
  passed: taxable GL/AR/PPN, ledger/outbox, idempotent replay and full
  transaction rollback, followed by guarded B4 rollback preserving **6 posted
  synthetic journal rows**. GitHub exact B4 SHA `985efb05` acceptance PASS
  on VPS using only 5 already SHA-256-reviewed original owner artifacts.
  The portable regression is
  `scripts/tests/customer_invoice_b4_original_owner_disposable.sh`.
  These offline results do **not** authorize active LOGIN or live posting.
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
