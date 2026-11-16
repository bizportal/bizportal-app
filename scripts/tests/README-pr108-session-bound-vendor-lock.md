# PR108 — Tenant-bound Vendor Invoice parent locks (DEV Draft, NO LIVE MIGRATION)

## Scope

This Draft PR **stacks on Draft PR107**, retaining the original 18 Finance RLS business policies, exact narrowly scoped table/column/sequence grants, PR106's OFF-by-default company-pool routing, and existing canonical Vendor Invoice/AP/Accounting PASS. It is a schema/security **rehearsal only**; the active CST-DEV Finance Writer, Accounting Handoff and Vendor Invoice upload remain disabled and PROD is untouched.

**Do not deploy the older PR102/103 GUC-based definer proposal.** It was useful for proving native PO/GR/Shipment row locks but its own authorization and RLS depend on the caller-settable `app.marketplace_company_id`. This PR's **superseding proposed function** uses the same canonical function signature and lock order with a different authorization boundary.

## Reviewed SQL files: intentionally blocked

- `scripts/sql/20261117_pr108_session_bound_vendor_lock_REVIEW_ONLY.sql`
- `scripts/sql/20261117_pr108_session_bound_vendor_lock_ROLLBACK_REVIEW_ONLY.sql`

Both files begin with a raised exception, which must remain in source. They **cannot execute directly** on CST-DEV or any other database. They are **not official Supabase migration records**. CI only strips the guard in temporary files inside a Docker `--network none` isolated PostgreSQL 16/17 container.

## Exact defense in depth

- Precondition: PR107's two company-bound staging roles must exist, still **NOLOGIN**, NOINHERIT, not superuser/BYPASSRLS, no inherited memberships, with the three relevant RESTRICTIVE FOR ALL company policies. The 11 key parent table column names/types and active RLS flags are read-only catalog-checked.
- Create `bizportal_finance_parent_lock_owner_dev` as a distinct NOLOGIN, NOINHERIT, NOBYPASSRLS owner, and private `finance_ops_private` schema not exposed through the Supabase Data API.
- Its UPDATE privilege is limited to PO `status`, GR `inspection_status` and Shipment `shipment_status` columns **only to allow native row locking**. The Finance login roles receive **no direct parent UPDATE**.
- Six owner-targeted SELECT/UPDATE policies on PO, GR and Shipment derive the allowed company from **`session_user`**. The owner executes the `SECURITY DEFINER` with `current_user=owner`, so using `current_user` inside the function would be wrong; the ordinary tenant GUC is not trusted.
- The static function checks strict company login allowlist, exact PO/company/supplier/token and wall-clock token expiry. It acquires row locks **PO → GR → Shipment** inside the canonical outer transaction; it performs no status mutation, SQL interpolation or payment action. Every unsupported login or mismatched PO/GR/token fails closed.
- The function has hardened `search_path=pg_catalog,pg_temp`, explicit PUBLIC EXECUTE revoke, private schema USAGE and exact EXECUTE for the two company roles **only**. The generic legacy Finance LOGIN and `anon`/anonymous roles cannot use it.
- After the transaction finishes, all native locks release. **This is not an elimination of deadlocks** if another writer takes Shipment before PO (PR104 reproduced `40P01`); global lifecycle lock ordering remains a release gate.

## Local disposable evidence

A synthetic 11-table/18-policy PR107 fixture is built in PostgreSQL 16. Both PR107 and PR108 checked-in install and rollback are confirmed **blocked**. Temporary copies install PR107's exact staged company roles and PR108's function, with six owner policies. **Only inside CI**, staged NOLOGIN company roles temporarily receive synthetic passwords and become LOGIN so separate local TCP SCRAM sessions can authenticate.

Tests pass:
- actual synthetic CST LOGIN with GUC set to company 3 locks only own CST PO/GR/Shipment; cross-company Diva token/rows rejected;
- actual synthetic Diva LOGIN with GUC set to company 1 locks only own Diva data; cross-company CST token/rows rejected;
- existing generic Finance LOGIN cannot call or obtain EXECUTE on the private function;
- rotated or expired vendor tokens rejected;
- three unrelated PostgreSQL writer sessions are blocked by native PO, GR and Shipment row locks (SQLSTATE `55P03`), then locks release and unrelated company data remain unchanged;
- PR108 rollback drops function/owner/schema/six policies exactly; PR107 rollback returns the original 18 policies and removes staging roles; all containers cleaned.

## Release blockers

This test is **direct PostgreSQL** and a simplified structural fixture. It does not exercise the genuine production-column Drizzle Vendor Invoice service via a company-bound SQL session, all 18 real CST-DEV business policy expressions together with real FKs, storage upload cleanup, signed HTTPS auth or AP/Accounting Draft handoff. Existing earlier canonical service tests using the old definer do not prove the new session-bound integration end-to-end.

No CST-DEV roles, passwords, GCP secrets, RLS policies, functions, hPanel flags, Nginx, journal, payment or PROD changes occur here. Before any activation, obtain independent security review of role and secret custody, staged role LOGIN enablement, full RLS semantics, Postgres pooler `session_user` binding, real company-specific connections, global fulfillment lock ordering, rollback and signed HTTP E2E. PR81/101/102/103/104/105/106/107/108 must remain Draft; never merge to main or enable Writer/Handoff/vendor upload prematurely.
