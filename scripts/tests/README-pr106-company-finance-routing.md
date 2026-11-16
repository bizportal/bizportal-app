# PR106 — DEV-only Finance connection routing by company (DRAFT)

## Goal

Route a **verified** CST (company ID 1) or Diva Servis (ID 3) Finance transaction to a company-specific PostgreSQL identity, not the shared generic Finance credential. Do this **only** behind an explicit new DEV flag. Preserve GET-only, Vendor Invoice/AP/Accounting and all previously PASS endpoints when flag is OFF.

This is a **source and disposable-test proposal**, not a live migration, not credential provisioning, and not an approval to activate Writer.

## Configuration — OFF unless explicitly approved

- New flag: `BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV=true`. If absent/false, the canonical existing single-role path is unchanged.
- This flag does **not** override `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV` or the existing independent GET-only flag; no Writer may open from a GET-only flag alone.
- Company ID **1** → DB role `bizportal_finance_cst_login_dev` → exact GCP Secret Manager secret name `bizportal-marketplace-finance-dev-cst`.
- Company ID **3** → DB role `bizportal_finance_diva_login_dev` → exact secret name `bizportal-marketplace-finance-dev-diva`.
- Company ID **2** (Wangsamas) and all unsupported IDs are rejected, not guessed and not sent through another company's pool. Extension to additional companies requires a separately reviewed mapping, role, secret and RLS policy.
- The company mode accepts **no direct database URL or generic Finance GCP secret**; stale legacy credential configuration aborts company-mode initialization rather than becoming a fallback. It never uses the generic shared postgres/PROD pool.

## Fail-closed data security and existing controls

- Only `APP_ENV=development`; exact project `xssrfshdrtdfupgqwfdw` and expected DB role/name/pooler; strict `sslmode=verify-full`, trusted CA path and hostname/pinned certificate; no extra or duplicate URL query parameters.
- Distinct pools (max one connection per company) and company-specific expected `current_user = session_user`. Refuse superuser/BYPASSRLS, missing RLS, and a changed credential or legacy/company-mode switch without a controlled service restart.
- Before executing business code, require an explicit **RESTRICTIVE FOR ALL RLS policy for the selected company role on all 11 canonical Marketplace/AP/Accounting tables**, plus NOINHERIT and **no role memberships**. Missing any policy fails closed. This is an additional readiness check; it does **not** independently prove each policy expression is semantically correct.
- Existing company GUC remains transaction-local as a legacy compatibility measure; security must come from the independently authenticated company DB role and restrictive policies. A compromised DB credential for one company must not be able to forge another company's role.
- `SECURITY DEFINER` owner becomes `current_user` *inside the function*: any future migration must bind its authorization to `session_user` plus the allowlisted company role, not trust only the caller-settable GUC. Source PR106 does **not** deploy or alter the previously proposed private definer migration from Draft PR102/103.
- The existing after-commit callbacks still run only after the outer transaction commits; no direct Finance parent UPDATE permissions, payment posting, or GL mutation are added.

## Verified

Local tests PASS: 96/96 combined original Finance/Writer/GET-only/Vendor Invoice tests plus new company-routing tests; TypeScript DB/API check PASS. Separate isolated PostgreSQL 16 test proves the role/policy catalog query detects 11 restrictive policies, a missing mandatory policy, and unexpected membership, then rolls everything back.

CI repeats with PostgreSQL 16 and 17 and preserves the already-PASS PR105 synthetic role-RLS and real-login `session_user` / private-definer tests. Do not claim PG17 on this exact source revision until CI succeeds.

## NOT ready for CST-DEV activation

No actual CST-DEV company login roles, passwords, GCP secrets, eleven-table restrictive RLS deployment, or private-definer `session_user` enforcement are installed. Actual CST-DEV still has the legacy 18 Finance action-specific policies and the old shared Finance role. A new RLS migration must cover all 18 operations, verified column-grant/sequence parity and the same company-bound identity; **11 restrictive FOR ALL policy presence checks alone are not a replacement for independent security review**.

Before deployment, separately approve secret creation and custody, DB role ownership and isolated TLS connections, RLS migrations and rollback, full PG16/PG17 canonical AP/Accounting/Invoice proof on real synthetic company identities, session-level authenticated HTTP/vendor-token upload E2E, and lock ordering across actual fulfillment writers. Keep Finance Writer/Handoff/vendor-upload OFF and PR81/101/102/103/104/105/106 Draft. No changes to active CST-DEV, Nginx or PROD in this PR.
