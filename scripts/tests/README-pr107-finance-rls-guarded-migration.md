# PR107 — guarded CST-DEV Finance RLS migration proposal (DRAFT)

## Goal and evidence

This change is deliberately scoped to **source-only, guarded SQL** for a future CST-DEV Finance company-role rollout. It stacks on Draft PR106 (which already has **96/96 Finance and Vendor contract tests PASS on PostgreSQL 16 and 17**). No application code or existing AP/Accounting services are modified here.

Actual read-only CST-DEV `pg_catalog` verified **18 original Finance policies across 11 tables**, all of which currently target the generic `bizportal_marketplace_finance_login_dev`. No change is made to their `USING` or `WITH CHECK` business conditions. The current Finance role is NOINHERIT and has zero direct PO/GR/Shipment UPDATE privileges. Its separate permissions include:
- SELECT on all 11 canonical Marketplace/AP/Accounting tables.
- Table-level INSERT on `mkt_ap_preparations`, `payment_requests`, and `mkt_accounting_handoffs`.
- Column-level INSERT on precisely **20 Vendor Invoice** columns and **9 Vendor Invoice Line** columns.
- Column-level UPDATE on precisely **9 AP Preparation** and **4 Vendor Invoice** columns. No other UPDATE.
- USAGE on precisely **5 finance ID sequences** for Vendor Invoice header/lines, AP, Payment Requests and Accounting Handoffs.

This proposal mirrors those effective privileges without broadening grants.

## Two guarded SQL review artifacts

- `scripts/sql/20261117_pr107_finance_company_roles_RLS_REVIEW_ONLY.sql`
- `scripts/sql/20261117_pr107_finance_company_roles_ROLLBACK_REVIEW_ONLY.sql`

**Both files begin with an unconditional exception and cannot be executed as-is.** They are NOT official Supabase migrations, have not been applied to CST-DEV, and must not be stripped of the guard except inside the disposable CI copy.

If separately approved later, the design would create `bizportal_finance_cst_login_dev` and `bizportal_finance_diva_login_dev` **NOLOGIN and without passwords** first. A separate, controlled credential release is needed to make a company role a real LOGIN, store a secret under the exact pinned GCP Secret Manager name, and start the company-bound Finance service.

The migration proposal extends only the `TO` role list of the **existing, verified 18 policies** (generic Finance remains a target) and adds an independent `AS RESTRICTIVE FOR ALL` policy to **all 11 tables**. A company's identity is `current_user` (role CST => company 1, role Diva => company 3). Child tables lacking company_id resolve it through their parent PO/Shipment/GR/Invoice rows. The caller-settable `app.marketplace_company_id` remains compatibility context for existing business policy clauses, not the security boundary.

## Isolated verification

The PR107 runner creates a synthetic eleven-table policy fixture that preserves the *names, commands and target role* of the 18 real Finance policies but uses simpler permissive predicates as a deliberate stress test. A fully guarded install/rollback is first required to **fail**; only temporary copies have the blocking guard removed, and those copies execute inside a Docker `--network none` PostgreSQL 16/17 container.

Checks:
- All 18 legacy policy expressions preserved byte-for-byte across install and rollback; exactly 11 new mandatory RESTRICTIVE FOR ALL policies, exactly 18 policy target lists expanded.
- **Zero effective column grant differences** between the original generic Finance role and each new company role.
- Both CST and Diva roles see only their own rows across all 11 tables even when the tenant GUC selects the other company; same-company Vendor Invoice INSERT and narrow AP/Invoice UPDATE succeed; opposite-company INSERT/UPDATE are denied.
- Original checked-in SQL remains non-executable. Rollback restores exactly the original 18 target lists and predicates, removes both staged roles and all 11 added policies; original fixture records remain unchanged after test transactions.
- No Supabase connection, credentials, GCP, token, HTTP upload, payment, GL posting, Nginx or PROD access.

## NO-GO conditions before any active CST-DEV change

- This is a migration **proposal**, not an independent security approval. It intentionally creates NOLOGIN roles only, so PR106's live Finance readiness gate cannot pass until a separately authorized credential provisioning phase.
- Existing generic Finance LOGIN/RLS policies remain active after staging, which means the prior **caller-controlled GUC trust boundary remains on that legacy credential** until a reviewed cutover and eventual decommission. Do not claim the whole environment is tenant-secure merely because new roles exist.
- The private vendor parent row-lock `SECURITY DEFINER` from PR102/103 must be independently updated to bind authorization to `session_user` for the selected company login, rather than only relying on a GUC. That work is NOT deployed here.
- Review policy semantics against real schema, RLS recursion, lock order across every Shipment/GR writer and rollback on a schema-accurate shadow DB. Verify company role credential custody, strict TLS, and the actual signed HTTPS Vendor Invoice→AP→Accounting Draft path before activating any Writer.
- Keep PR81/101/102/103/104/105/106/107 **Draft**. No blanket UPDATE/INSERT, no shared privileged pool, no merge to main, no active CST-DEV changes and **never touch PROD** without separate authorization.
