# PR102 — Vendor Invoice parent row-lock prototype (DISPOSABLE ONLY)

**Do not deploy to CST-DEV or PROD.** This Draft PR proposes a minimal, DEV-only opt-in source branch so the **real** canonical vendor invoice service can use a narrowly authorized database row-lock routine, while preserving the existing `FOR UPDATE` path when the opt-in is disabled.

## Original incident / baseline

- Draft PR #81 and its merged test PR #100 already PASS matched Invoice → AP → draft Accounting Handoff. Preserve those results without rebuild.
- Draft PR #101 independently reproduced PostgreSQL 42501 on `mkt_purchase_orders`, followed by 42501 on `mkt_po_goods_receipts`, when the restricted Finance role attempted `FOR UPDATE` under SELECT-only parent privileges.
- Vendor token upload calls `createMarketplaceVendorInvoice(input,actor,scopedDb)` inside a tenant-bound Finance transaction; `scopedDb` is a transaction-bound Drizzle client, not the default privileged DB.

## Proposed source-only, explicit DEV opt-in

The canonical `createMarketplaceVendorInvoice` service keeps its existing parent row lock statements unless **all** of the following are true:

1. A transaction-scoped database other than the default `db` is passed.
2. `APP_ENV=development`.
3. `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true`.
4. `BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV=true` (new flag, default OFF).

With the opt-in, service calls `public.mkt_finance_lock_vendor_invoice_parents_dev(po_id,gr_id,supplier_id,vendor_token)` **inside the same transaction**, then reads PO/GR without a second `FOR UPDATE`. The function either acquires both native PostgreSQL row locks in the original PO→GR order and returns true, or fails closed. Missing function, missing grants, invalid company or supplier, a rotated/expired vendor token, and cross-company PO/GR pairing must not produce an authorized invoice. The row-lock routine re-checks the exact opaque vendor token and expiry while holding the PO lock, closing the rotation window between route-level validation and database insertion.

The disposable prototype uses a dedicated **NOLOGIN / NOINHERIT / NOBYPASSRLS** definer owner, scoped RLS SELECT and UPDATE policies, read-only access to shipments, and limited UPDATE-column grants *to that owner only* for PO `status` and GR `inspection_status`. It grants only function EXECUTE to the synthetic Finance role; direct Finance UPDATE privileges on PO/GR remain **false**. Function body is static SQL, SECURITY DEFINER with hardened `search_path=pg_catalog,pg_temp`, no arbitrary SQL or other mutations, and company ID derived from the transaction-scoped `app.marketplace_company_id` GUC.

**Security limitation:** this does not independently authenticate the selected company. The existing Finance transaction helper must continue to verify the signed Super Admin or vendor-token company and bind the company setting. PostgreSQL custom GUCs are caller-settable; a compromised Finance DB credential would not be confined to a tenant by this function alone. Treat tenant binding, credential custody, and exact EXECUTE grants as mandatory release-review items. The routine also does not lock Shipment rows, matching the existing service but requiring concurrency review before rollout.

## Verified disposable PostgreSQL 16 tests

- `pr102-vendor-definer-e2e.ts`: canonical service creates CST and Diva invoice in their authorized scopes; replay returns identical invoice ID; no duplicates; rotated or expired token denied under the locked PO; cross-company read/create denied; existing role cannot UPDATE PO/GR; unrelated database role cannot execute routine; disabled flag fails closed with 42501; outer transaction intentional rollback removes every fixture, role, routine and invoice.
- `pr102-vendor-parent-lock-concurrency.ts`: exact shared routine locks PO and GR while two unrelated PostgreSQL writer sessions try to change the same PO status and GR inspection state; both get native lock timeout `55P03`. After the lock owner rolls back, both writers succeed and other company rows remain unchanged. All temporary objects and roles are removed.
- Test DB URL is hard-checked against synthetic `pr81pg:5432/cst_pr81_writer_ci` with exact synthetic credentials; Docker networks are `--internal`, no published ports, no host database mounts, no external activity/notifications, and no GCP/Finance/Supabase credentials.
- Local tests and API TypeScript typecheck completed successfully. Official CI must pass on this PR head before merge to the PR #81 Draft branch.

## NO-GO / review

- **PR #81, #101 and #102 must remain Draft.** This is an isolated source / test proposal, not a ready migration.
- Do **not** apply test SQL, create DB roles/policies/functions on CST-DEV, add direct Finance UPDATE, turn on Writer/Handoff/vendor upload, change Hostinger preview/Nginx, send payments, post GL, or touch PROD.
- A separately reviewed, exact CST-DEV migration is needed. Reviewers must independently assess definer owner creation/ownership, public EXECUTE revocation, tenant/RLS policy equivalence and possible custom-GUC spoofing, concurrency including Shipment lifecycle, session authorization, and rollback script.
- Only after that independent review, separate authorization and genuine signed HTTPS service-to-CST-DEV tests could Writer be considered for DEV activation.
