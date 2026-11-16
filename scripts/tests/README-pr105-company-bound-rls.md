# PR105 — Finance company-bound database roles (DESIGN GATE ONLY)

## Purpose and baseline

Preserve all prior PASS from Draft PR #81/#101/#102/#103/#104. This PR is a **source-only security design rehearsal**, not a live migration, deployment or feature activation. It documents one way to prevent an attacker or arbitrary SQL under a single Finance DB credential from changing `app.marketplace_company_id` and obtaining access to another company. The current generic Finance role remains unchanged in active CST-DEV.

Read-only CST-DEV inventory: 18 Finance RLS policies across eleven Marketplace and AP/Accounting tables (PO, PO lines, Shipment, Shipment items, Goods Receipt, GR items, Vendor Invoice + lines, AP preparations, payment requests and accounting handoffs; each action-specific policy appears in the full catalog). Supabase PostgreSQL is v17. Do **not** change any of those roles/policies from this PR.

## Design tested in disposable PostgreSQL

1. Separate immutable database identities, `ci_pr105_cst` (CST company ID 1) and `ci_pr105_diva` (Diva company ID 3), with NOINHERIT, NOBYPASSRLS, no shared role membership and no direct global superuser access. These are *synthetic NOLOGIN roles only*; no secrets or new live credentials are created.
2. Mandatory **RESTRICTIVE** RLS policies check `current_user` against the company role, not `current_setting(...)`. On children without `company_id`, verify the parent through the restricted role-readable PO/Shipment path.
3. Include an intentionally permissive legacy GUC-based policy and a separate `USING(true)` policy to prove that additional permissive SELECT policies cannot bypass the mandatory guard. (PostgreSQL permissive policies OR together; restrictive policies AND together.)
4. INSERT `WITH CHECK` blocks cross-tenant invoice creation for either role, while same-company INSERT succeeds. Direct attempts to replace the tenant GUC with the other company do **not** alter accessible rows or create cross-company invoices.
5. All synthetic DDL, policy/grant fixtures, rows and roles are within `BEGIN...ROLLBACK`. An external container with `--network none` has no connection to Supabase, GCP, VPS databases, email, object storage or PROD.

**PG16 local PASS:** CST and Diva reads remain company-specific under wrong tenant GUC, both cross-tenant inserts denied, and no fixtures remain after rollback. **PG17:** requires successful exact-head CI before claiming PASS.

## Important limits before deployment

This does not replace the real 18 Finance RLS policies, authenticate real company-role credentials, or prove current canonical Drizzle services can use two new company-bound pools. It only verifies the fundamental mandatory DB identity constraint. Existing service uses one restricted Finance connection plus transaction-local company GUC; switching to two credentials would require separately approved secrets, TLS-role validation, allowlist mapping and credential rotation, and a source-only integration gate preserving GET-only and all AP/Accounting PASS.

All relevant parent/child RLS policies, column grants, sequences, and `finance_ops_private` EXECUTE rights must be redesigned for the two roles; **a per-company role alone is not enough if any table lacks the mandatory restrictive guard**. RLS OR composition, owner bypass, function security and role membership require independent review. Never widen grants or silently switch to a shared privileged pool to make a test pass. Make a rollback design before applying any live migration.

## Lock ordering dependency

Draft PR103's canonical Vendor Invoice definer acquires PO → GR → Shipment. Draft PR104 proves an external writer that locks Shipment then PO can cause SQLSTATE 40P01; the endpoint now returns HTTP 503 and cleans the uploaded synthetic proof without retry. Review all actual Customer Portal/Marketplace and fulfillment writers for lock order and failure behavior; the current canonical `bizportal/bizportal-app` source does not itself prove every external writer has adopted the same ordering. Do not conflate deterministic deadlock detection with eliminating deadlocks.

**NO-GO:** PR105 remains Draft; no CST-DEV/PROD database role/DDL changes, no feature flags, no Nginx or customer data writes, no real payment/journal. No merge to main or live Writer activation without independent security sign-off and signed HTTPS E2E.
