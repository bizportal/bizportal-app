# CST-DEV Customer Invoice — actual paid Payment/AR replay and rollback verification

**Source-only QA, not hosted CST-DEV or PROD financial release.**

## Source pins

- Customer Portal Draft PR #237 exact SHA
  `cd7e6cd03219a8689db4a69279410d1e6482d309`.
- Existing BizPortal Owner signer PR #155 exact SHA
  `9ade41f0ab3459841a7e3b154202357f9000496d`.
- Original unchanged `CanonicalPostingEngine` from BizPortal PR #142;
  all five ESM artifact SHA-256 pins retained and tested.

## Original code used

The QA invokes the ACTUAL `handleAdminPayments` along with the actual
`handleAdminInvoices` and original posted Sales Invoice/AR trigger.
It loads 122 real CST-DEV Invoice writer RLS policies and the exact
read-only column/sequence permission metadata into an **ephemeral**
PostgreSQL16 fixture; B6 tax-lock and the two pending audit-column
grants are applied only in that disposable database.

## Evidence (CST + Diva)

1. One synthetic signed Owner review issues a Rp111 Sales Invoice
   using the original Accounting GL, PPN, AR, audit and financial outbox.
2. A synthetic authorized Admin changes a synthetic Rp40 payment
   from `pending` to `paid`, and the original deferred AR trigger
   projects Invoice partial, AR paid=40, outstanding=71.
3. A verified paid-status replay is idempotent: no second amount,
   journal, AR or payment notification is added.
4. **Deferred trigger failure injection:** within the disposable
   database, temporarily disable the original Sales document AR
   after-source trigger. The payment handler's new DEV financial
   check rejects its otherwise-valid Rp40 payment with 422, and
   the original transaction rolls back both Payment status and
   Invoice amount, leaving prior AR untouched. Reenable the trigger
   in the same ephemeral QA environment and original payment succeeds.
5. **Stale paid-replay injection:** temporarily corrupt only the
   synthetic Invoice amount-paid source to 0 after settling its
   original payment, leaving `payments.status='paid'` and the original
   AR projection at 0. An `already paid` replay is rejected with 422
   instead of returning a false 200. Restore original Sales source
   amount_paid=40 and let original AR trigger project; a legitimate
   replay succeeds again with zero duplicate writes.
6. Both CST and Diva run each scenario; foreign/unassigned Admins
   remain denied, and original GL/PPN/outbox and notification scope
   remain unchanged. Container and generated QA bundles are removed.

## Invariants and boundaries

The new source guard is enabled only by the prior existing DEV
financial flags and is not enabled automatically in active Portal.
It reads existing reviewed posted journal/AR/evidence; it does NOT
create or modify any cash/bank journal and is **not** a bank
settlement/reconciliation test. Real Owner OTP delivery, HTTPS
browser session, active hosted PostgreSQL role credentials and
legitimate `to_invoice` business source remain independent NO-GO
release gates. All actual CST-DEV/PROD data and financial flags
remain unchanged.
