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
