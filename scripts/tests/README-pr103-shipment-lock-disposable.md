# PR103 — Shipment status race guard for Vendor Invoice (DEV-only draft)

## Findings from exact PR102 baseline

Draft PR102 already proves the canonical `createMarketplaceVendorInvoice` service can create and replay scoped Vendor Invoices with PO and Goods Receipt locks, a private-schema `SECURITY DEFINER` function, restricted Finance role and rollback. Its original function does **not** lock the Shipment row, while the canonical service separately tests `shipment_status = 'delivered'`. An unrelated shipment writer can update `mkt_po_shipments.shipment_status` while PO and GR are locked. This gap was reproduced in the isolated PostgreSQL 16 concurrency harness with a synchronous UPDATE of Shipment status while the PR102 function held the parent locks; it returned one updated Shipment row without waiting. This is a race, not a documented live CST-DEV failure.

## Narrow additive change

The existing function, in its **unexposed** `finance_ops_private` schema, now locks the parent records in a fixed order: PO → Goods Receipt → **Shipment**. It issues `SELECT ... FOR UPDATE OF sh` on exactly the Shipment referenced by the locked GR, requiring a single additional `UPDATE(shipment_status)` privilege and tenant-scoped UPDATE RLS **for the NOLOGIN definer owner only**. The dedicated Finance login retains **no UPDATE** privilege on any of the three parent tables; it only has function EXECUTE and schema USAGE. Existing token checks, supplier/company binding, service-side `delivered` validation, invoice replay and default OFF gates stay unchanged. No new endpoint, login, payment, journal, AP or Accounting module.

The two guarded `REVIEW_ONLY.sql` install/rollback files have matching owner grants, shipment RLS policy and function-body changes; both still deliberately RAISE before any DDL. CI is restricted to a disposable database and verifies a temporary stripped-guard copy. These files are **not official migrations**, and are not authorized for CST-DEV.

## Disposable PostgreSQL 16 and 17 release gates

1. Actual canonical Vendor Invoice service using isolated Finance role: scoped CST/Diva creation, replay and no duplicate, expired/rotated token denial, invalid company denial, fail closed when flag disabled, and rollback.
2. Independent connection attempts to rotate PO vendor token, change GR inspection status, and change Shipment status while one transaction holds the three row locks. All three must be blocked by native PostgreSQL 55P03; after release, valid writers proceed, with no change to the other company's data.
3. Finance role has no direct UPDATE on PO, GR **or Shipment**, unauthorized role has no EXECUTE privilege on the private routine, private schema and all synthetic objects removed.
4. SQL install and rollback reject direct execution, and stripped-guard disposable copies install/lock/rollback with 18-policy synthetic baseline preserved. TypeScript and vendor-token route tests remain green.
5. PostgreSQL 16 baseline plus PostgreSQL 17 to match CST-DEV engine major version. The VPS cannot currently reach Docker Hub to pull the PG17 image, so its independent confirmation must come from the GitHub CI PG17 job.

## Release blockers remain

- No SQL, roles, policies or function may be applied to active CST-DEV or PROD based on these tests alone.
- Independent review of the custom caller-settable company GUC / Finance credential trust boundary, ownership and privileges of the security definer, all 18 real Finance policies, and real Shipment/GR lifecycle lock ordering is required.
- Full deployed HTTPS vendor token + file upload + rollback / object-storage cleanup has not been exercised.
- PR81/101/102/103 must remain Draft pending separate approval. Existing AP/Accounting PASS are preserved, Finance Writer/Handoff and vendor-upload flags remain OFF.
