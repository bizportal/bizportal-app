# CST-DEV Marketplace AP to bank to GL: release acceptance

Scope: DEV only; no payment execution or journal posting. Existing Invoice, AP,
handoff, reconciliation and canonical posting are unchanged.

Verified:
- AP makes one Payment Request draft and Handoff, idempotent by AP ID.
- Canonical bank posting checks mutation, company, journal identity, GL balance, duplicates and replay.
- Disposable PostgreSQL canonical posting previously passed six tests.
- Server-side company selection and signed Super Admin Finance authorization already exist.

Unproven:
- Bank execution evidence is not linked to the originating Payment Request.
- The AP-to-bank-to-GL finalization path is not deployed nor E2E proven.
- Marketplace invoices remain ready_for_ap while the existing vendor-invoice bank allocation
  requires posted status. A documented and tested canonical adapter is mandatory. Never
  silently promote ready_for_ap to posted to make the test pass.
- Genuine signed Super Admin HTTP bank-posting acceptance is not proven.

The newly added pure release admission module is not mounted to any HTTP route.
It accepts a verified actor and *server-provided* transaction evidence and
reports GO_CANDIDATE or NO_GO. It never transfers funds, pays a request, or
posts any journal. GO_CANDIDATE is not payment authority.

A final bridge must, within a locked atomic transaction:
1. obtain the actor via the existing signed-session server identity, not request headers;
2. bind invoice, AP, handoff, request, bank mutation, and bank account to one company;
3. verify genuine owner approval, Treasury readiness, proof of bank execution,
   active company-specific COA mapping, and bank reconciliation evidence;
4. use canonical posting only, guarantee balanced entries, and reject competing matches;
5. ensure an immutable idempotency key; rollback on injected failure;
6. finalize Payment Request only after confirmed bank posting and audit.
A transfer cannot be marked paid based on a draft handoff or caller-supplied status.

Status: existing AP-to-Accounting Draft GO; real disbursement/final GL NO-GO
until the bridge and real signed-session E2E are verified.

## Atomic posted-bank finalizer candidate
marketplacePaymentFinalization.ts is an UNMOUNTED transaction service. It never
sends a transfer or posts a GL entry. After an actual bank reconciliation has
already posted an outgoing mutation, it verifies a bank-import record, immutable
AP/request/handoff identifiers and fingerprint, signed Super Admin authorization,
existing approval and Treasury fields, canonical payment-request bank match,
journal balance, matching active company bank account/COA, and duplicate matching.
It then atomically marks ONLY that Payment Request paid, updates the Handoff to
posted, and inserts an audit record. Failures trigger full ROLLBACK; replay
requires exact same posted bank/journal evidence. It blocks foreign company data.

Disposable PostgreSQL tests cover success, replay, concurrent requests,
mismatched company, wrong references, invalid status, failed audit after
updates, broken journal balance, and bank/COA mismatches. This is not real
signed-session HTTP E2E and does not prove the existing canonical bank
reconciliation can produce its required payment-request-specific match/source
tags. These two integration gaps remain release blockers. Do not deploy or
enable a POST until the match adapter and signed HTTP acceptance are verified.

## Canonical native Vendor Invoice allocation adapter (2026-11-20)
The unchanged Bank Reconciliation implementation emits one approved
vendor_invoice match, active payment_allocations and payment_matching_groups,
and linked_transaction_type vendor_invoice_batch. It does NOT emit the
payment_request candidate/source identifiers assumed by the initial draft.
The proposed unmounted nativeVendorBankEvidence.ts now verifies those
existing records with row locks and with the locked AP/Handoff/PaymentRequest
chain, requiring identical company, invoice, mutation, approved match,
exact monetary amount and one active allocation in one matching group.
It refuses shared groups, batches spanning multiple invoices, and a second
posted mutation with an active allocation for the same invoice.
There is NO fabricated Payment Request match or bank mutation source tag.

Current Bank Reconciliation pays only a legitimately posted Vendor Invoice.
The candidate finalizer therefore requires invoice status posted; it will NOT
automatically turn Marketplace ready_for_ap into posted. A genuine, reviewed
Invoice posting step and bank-confirmation workflow remain requirements.
No HTTP routes are mounted; no bank transfers or accounting postings are
initiated by these components.

Disposable PostgreSQL regression: 79/79 combined tests PASS (includes
native allocation proof, concurrency, replay, audit-failure rollback,
CST/Diva authorization and the existing AP tests). API typecheck PASS.
These are staged candidate tests, not a real signed-owner HTTP E2E.
