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

## Reviewed Marketplace status adapter candidate — 20 November

The existing Purchase UI references a legacy Vendor Invoice POST action, but
no matching posting route was found in the scoped API source reviewed here.
We do NOT create a fake posting operation or change the Marketplace status.

A narrowly gated branch in the existing bank-reconciliation
vendor-invoice-payment-batch writer now permits a *single* Marketplace
ready_for_ap Invoice only if:
- APP_ENV=development and BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV=true
  (default OFF, never enabled by this PR);
- the authenticated request carries an actual server-verified signed Super Admin
  session, including approved Finance company scope;
- the existing imported outgoing bank mutation, canonical AP, Payment Request,
  verified Finance/Treasury approval, Handoff, supplier, amount and immutable
  fingerprint all match within the existing bank writer transaction.
Other statuses and multi-invoice batches are refused; the original legacy
posted-Invoice allocation path is preserved.

The unmounted atomic finalizer has also been aligned to expect the actual
Marketplace ready_for_ap Invoice, after canonical single-invoice bank evidence
and GL have been posted. It does not mark the Invoice posted, initiate a
transfer, or fabricate proof.

Evidence: 94/94 combined tests PASS covering the status adapter, canonical
bank evidence, atomic finalization, replay/rollback, authorization and existing
posting contracts, with real disposable PostgreSQL queries for the adapters.
API typecheck PASS. The test container was stopped and must be removed.
This is not a real signed Owner HTTP E2E and remains NO-GO for real payments.

## Signed Owner QA button (SAFE UI acceptance candidate)

The new frontend route /finance/payment-approval-qa contains a visible functional
"Setujui Pembayaran Uji" button and is linked from Finance Vendor Invoice preview.
It uses a signed server-side Super Admin session, a verified CST/Diva company
scope, and an isolated PostgreSQL QA database bound to 127.0.0.1:55495 and
database name finance_approval_qa. Its acceptance endpoint is disabled by
default, refuses cross-origin POST, prevents replay/double audit, and never
touches payments, bank transfers or financial journals.

This is a REAL UI-to-server approval QA test, but specifically NOT the real
supplier-payment E2E. It exercises Super Admin approval only. Do not confuse
the QA receipt with a bank settlement or accounting posting receipt.

No owner action is requested until the candidate is actually deployed and
verified in a browser. PROD unchanged.

## Signed Super Admin QA button — deployed in Finance DEV preview

Deployment verified under finance-pr81.72.61.210.205.sslip.io:

- Web page: /finance/payment-approval-qa HTTP 200
- Functional React button chunk HTTP 200; React DOM tests 2/2 PASS
- Authenticated QA endpoint /api/mkt/admin/payment-approval-qa (GET/POST only);
  anonymous HTTPS GET returns 401, production bank POST remains 404
- HTTP integration on isolated PostgreSQL with synthetic signed-auth mocks: 4/4 PASS
  (success, exactly-once audit, replay, anonymous/wrong role/tenant,
  cross-origin and flag OFF restrictions)
- QA PostgreSQL 127.0.0.1:55495/finance_approval_qa only, two synthetic
  cases for CST and Diva, no bank transfers and no BizPortal GL transactions.
- Main Finance backend remains the existing c1abee7 runtime. The only added
  HTTPS API route proxies to a separate QA-only runtime on 127.0.0.1:19882.
  The static Finance frontend bundle was updated with an on-disk rollback.
- Both QA endpoint and frontend explicitly label this as a sandbox approval,
  NOT proof of the real supplier-bank-reconciliation posting E2E.
- Real signed Owner browser click has not yet occurred, and the authentic
  payment-to-bank posting path remains NO-GO.

Build sources were aligned from the c1abee7 preview baseline plus candidate
changes, avoiding unrelated changes from the older QA workspace. Vite built
successfully after the first constrained heap failed; API typecheck PASS.

## 403 Finance scope recovery — DEV UI fix
The screenshot of an authenticated Super Admin showed HTTP 403:
"Pilih dan verifikasi perusahaan Finance". Root cause: the signed Finance
company-scope cookie had not been issued for the QA screen opened directly,
although the BizPortal company selector showed CST. The QA backend must
continue refusing an unscoped global Super Admin.

The scoped QA frontend now retries only after a 403, using the EXISTING
server-validated POST /api/mkt/admin/finance-company-selection with the
user-selected, strictly allowlisted company ID (1 CST or 3 Diva). It checks
server confirmation and retries QA GET once. It does not attempt an
auto-selection on 401 or on an unsupported company, and checks that the QA
response company equals the selected UI company. A successful QA response
replaces the manual verify card with a verified-company indicator.

React/jsdom regressions: 5/5 PASS, covering success, retry 403, 401 without
scope selection, unsupported company and sandbox click receipt. Existing
backend isolated HTTP QA: 4/4 PASS. Frontend Vite production build PASS.
UI static bundle deployed in Finance DEV (no backend/PROD changes).
HTTPS approval screen 200, new JS chunk 200, unauthenticated QA GET 401,
main Finance health 200, bank POST remains 404. Rollback at
/var/lib/bizportal-finance-preview-rollbacks/20261120-signed-approval-ui-scope-fix-final.
Real owner browser action has not been accessed by the connector. QA scenarios
remain pending without any audit rows. No real transfers or GL posted.

## QA approval concurrency and rollback validation (2026-11-20)
On the existing, separate localhost-only finance_approval_qa PostgreSQL,
real HTTP integration tests now include two concurrent signed synthetic
approval requests: one first successful transition, one idempotent replay,
exactly one audit row. A database trigger fault injected into the approval
audit INSERT after the status update returns HTTP 503 and proves full
rollback to pending with no audit. The trigger is removed in test cleanup.
6/6 approval HTTP tests PASS; no production cookies or real Owner credentials
were generated or read. This remains a synthetic authenticated harness,
not the genuine Owner browser acceptance and not the bank/GL E2E.

## Real Marketplace Payment Request approval candidate (CST-DEV 2026-11-20)
The new marketplacePaymentApproval.ts service targets the real Marketplace AP
Payment Request draft through the existing company-scoped Finance transaction.
It verifies signed Super Admin identity, CST/Diva company, the immutable
AP/Invoice/Handoff relationship, three-way match, and amount snapshots.
Only draft to approved and single Super Admin Treasury readiness are recorded.
It does not pay, transfer, reconcile or post any journal.
Replay creates no new audit. An audit INSERT failure rolls back the status.

The dedicated POST candidate path is
/api/mkt/admin/payment-requests/:id/approve and the release flag is
BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV=true (OFF by default).
Same-origin JSON, role, company and valid ID are required.

The narrow SQL migration was applied only to CST-DEV after disposable
PostgreSQL QA. Only approval columns are writable by the company Finance
roles. Both roles still cannot UPDATE total_amount, paid_amount or journal
ID, nor INSERT GL entries. The RLS-protected audit table accepts exactly one
approval per request. The rollback SQL is included.

Evidence: isolated PostgreSQL approval tests 7/7 PASS; existing and new
HTTP writer tests 37/37 PASS; combined targeted 44/44 PASS; API typecheck
PASS. CST-DEV postflight: 0 active Payment Requests/Handoffs, 0 new approval
audit, historical CST Invoice fingerprint unchanged. Active Finance DEV
runtime is still c1abee7, and the business-approval path is NOT enabled.
Authentic Owner E2E and the real bank/GL pipeline are still NO-GO.

## Integrated approval → posted-bank evidence → finalization (disposable PostgreSQL)
A new integration sequence was added to
marketplacePaymentFinalization.test.ts. Starting with an actual synthetic
Marketplace AP Payment Request in draft, the test invokes the same
approveMarketplacePaymentRequest service in a PostgreSQL transaction,
commits the approval and audit, then invokes the canonical-evidence
checking finalizer against a matching synthetic posted bank mutation,
allocation and balanced GL journal. It proves approved→paid is only
possible with verified posted evidence and that replay returns REPLAY
without double audit. A separate negative case starts with draft and
rejects finalization. This is a composition test, NOT a real bank posting
or a signed browser E2E: the bank evidence is pre-seeded in the fixture.

Disposable PostgreSQL integration: 15/15 PASS; broader Finance/AP and
canonical posting contract regression: 82/82 PASS; API typecheck PASS.
No change to the existing bank posting service or running Finance preview.
Production and business GL remain untouched. A genuine bank posting
workflow and authentic signed Super Admin HTTP request remain release gates.

## Narrow independent approval-only gate — 21 November 2026

Audit found the first real Payment Request approval handler depended on
BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV, the general Finance
writer switch. Enabling it for the sole purpose of verifying approval
would also expose unrelated vendor invoice and AP writer operations.

The candidate code now has an independent approval-only transaction option
and handler guard. Both BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV
and BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV must explicitly
be true, APP_ENV must be development, and the independent tenant-bound
Finance PostgreSQL role and the existing full RLS/11-table readiness checks
remain mandatory. The common Finance Writer flag is NOT required. Unrelated
writers continue to return 404 when their general flag is OFF.
No external after-commit actions may be registered in approval-only mode.
When the approval flag is OFF, the handler returns 404 before session lookup.

New tests: 39/39 approval HTTP tests PASS including isolation from vendor
invoice/AP writers; 5/5 DB guard tests PASS. API TypeScript typecheck PASS.
Two preexisting isolated PostgreSQL suites were not rerun in the combined
test because their disposable containers (ports 55493 and 55497) had been
removed; their historical PASS remains separate and is not included in
the current run.

This is a code-only change on a draft PR. Neither the unrestricted Finance
writer nor the new approval-only flag was enabled on the currently deployed
Finance DEV backend. Real Payment Requests count was zero as of last
read-only DB inspection; no bank or journal was posted.
