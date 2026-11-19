# Customer Invoice DEV — 122 exact RLS policies + original Accounting E2E

**Source-only QA; no hosted CST-DEV / PROD database changes.**

## Purpose and evidence source

Prior PR #158 mirrored actual CST-DEV writer table/column/sequence GRANTs
on disposable PostgreSQL16, but modelled financial row-level security
using synthetic generic company RLS. This test removes that shortcut.

Via read-only `pg_policies`, capture the exact **122 policy definitions**
for existing dedicated CST/Diva Invoice writers on **21 tables**
(`public.users`, `sales_documents`, Accounting journals, tax mapping,
financial outbox, AR, audit and Portal customer/notification tables).
Persist only schema/policy metadata, not user records or credentials,
in `scripts/tests/customer-invoice-hosted-rls-source-snapshot-20261119.sql`.
The file refuses any database name other than `invoice_synthetic`.

Run inside an ephemeral localhost-bound PostgreSQL16 container, with
the preceding real 22-table column-ACL snapshot and nine sequence grants.
Drop only prior disposable synthetic writer policies, install the real
captured per-role policies, and preserve the original reviewed AR trigger.

## Findings confirmed with actual RLS

1. **Initial separate staff Admin issuance is denied.** The existing
   B2 `public.users` RESTRICTIVE ALL policy allows only canonical active
   `super_admin`. Additional existing B3 rowlock is also owner-only.
   The prior B5 staff SELECT/rowlock policy draft by itself cannot
   override that RESTRICTIVE ALL. Do not silently promote or grant.
   The existing matched Owner/Portal Admin is eligible to issue a
   first company Invoice themselves, with one signed Owner approval.
2. **Original B6 tax FOR SHARE was incomplete** under real RLS:
   B1 uses RESTRICTIVE ALL plus PERMISSIVE SELECT, while B6 originally
   added only RESTRICTIVE UPDATE policies and narrow timestamp-column
   UPDATE privileges. FOR SHARE silently yielded zero settings/tax
   rows for both companies. The newly reviewed Portal
   [Draft PR #233](https://github.com/Travelintrips/CST-CUSTOMER-PORTAL/pull/233)
   keeps the original RESTRICTIVE policy and adds exactly four scoped
   PERMISSIVE UPDATE policies, each `WITH CHECK(false)`. This permits
   row locking without permitting any update to tax/config values.
3. Both hosted writer roles still lack audit `INSERT(change_reason,
   after_state)`, independently repaired by the narrowly scoped
   Draft PR #157 permission proposal. It is NOT applied to hosted DEV.

## Reproduction

`bash scripts/tests/customer-invoice-modern-role-pg16.qa.sh` runs:

- Unchanged original BizPortal PR142 CanonicalPostingEngine and 5/5
  SHA-pinned owner bundle tests, including original 11% and 12%
  synthetic PPN cases, audit/outbox, replay and rollback.
- The real CST-DEV table/column/sequence GRANT snapshot (PR158).
- All 122 real Invoice B1/B2/B3/B4 RLS policies (this QA extension).
- Negative source locking: original restrictive-only B6 fails for
  CST and Diva; with the pinned Portal PR233 PERMISSIVE correction
  both company row locks PASS, even when trying to alter timestamps
  (updates remain denied).
- Readback that the global canonical Owner is visible to the writer
  and a separate staff Admin is invisible under current B2 RLS.
- Synthetic role-specific original Owner signs a fresh source digest
  via the current BizPortal PR155 Ed25519 HTTP QA signer; original
  Portal PR233 `handleAdminInvoices` on same direct PostgreSQL
  RLS session drives actual original CanonicalPostingEngine.
- Actual posted 3-line GL, PPN, AR, original audit, financial outbox
  and replay are verified for company1/CST and company3/Diva.
- Non-Owner signer and wrong-Invoice signed proof are denied; no
  unauthorized financial posting remains after rollback.
- Docker QA container and generated ESM bundles auto-cleaned.

## Real-world release boundaries

Results remain an **isolated E2E with simulated OTP email session and
local HTTP**, not live Owner login/OTP delivery, HTTPS phone browser
session, actual hosted CST-DEV RLS at run-time, or PROD. The original
source schema fixture matches only the columns needed for these tests.
Real hosted roles remain NOLOGIN; there are zero new to_invoice rows,
no enabled Invoice AR actor, no B6 policies or two audit-column grants
applied, and the active Portal original Accounting bundle path remains
unmounted. Both finance flags and PROD stay unchanged.

**Release decision: Owner-issued code path / exact-role-policy QA PASS;
hosted financial cutover remains NO-GO.**
