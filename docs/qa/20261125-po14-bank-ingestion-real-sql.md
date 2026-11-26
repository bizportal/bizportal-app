# PO14 Finance — real bank ingestion and SQL evidence

**Status: isolated service/worker verification PASS; real Owner browser acceptance pending.**

**26 November update:** the real Super Admin session and CST scope were verified,
but the signed execution returned HTTP 503 during worker cleanup. See the
[cleanup race investigation and repair](20261126-po14-worker-cleanup-race.md)
for the current evidence. The deployment observations below are dated
25 November; the login-pending observation is historical.

Continuation of [PR #166](https://github.com/bizportal/bizportal-app/pull/166), based on
`012cbc4f63d69eb4967beb5a7e5ea8d8b0178658`. This extends the existing Finance
services, runner, endpoint, and page; it does not replace the application.

## What now executes

The isolated chain creates the Invoice and lines through
`createMarketplaceVendorInvoice`, performs the actual three-way match, creates
and reviews AP, creates its Payment Request/handoff, and executes approval.
`syncOneBankSheetConfig` then parses synthetic Sheet rows and inserts the bank
mutation through its normal SQL. Automatic matching persists the candidate.
The existing vendor allocation writer creates the matching group, allocation,
draft journal, and journal lines. `postBankMutationCanonical` posts that journal,
and `finalizePostedMarketplacePayment` completes the Payment Request.

Bank mutations, candidates, allocations, and journals are **not pre-seeded as
completed transactions** in this new chain. Replay and an intentionally failed
audit insertion are verified against SQL state.

## Gaps corrected

| Gap found by extending the real chain | Correction |
| --- | --- |
| Sheet imports have no `import_row_id`/`import_batch_id`, so the old admission gate rejected them. | Verify the existing Sheet provenance: active configuration, matching company and bank account, canonical hash, amount, and direction. No invented import IDs. |
| Discovery considered only `posted` vendor Invoices; Marketplace creates `ready_for_ap`. | Add DEV-only candidate discovery using the same signed Super Admin, approved Payment Request, and locked AP/Invoice/handoff checks. Preserve the Invoice status. |
| Generic approval could omit Marketplace allocation checks. | Route Marketplace payment through the canonical batch writer, with full single-Invoice allocation and approval evidence. |
| The old fixture included `accounting_entry_lines.company_id`, absent from the repository schema. | Verify journal and COA tenancy; the new fixture removes the invented column. |
| The bank writer existed only inside its HTTP route. | Extract `allocateVendorInvoiceBankBatch`; the route and isolated worker reuse the same SQL implementation. |
| The existing PO14 page recorded seven `SIMULATED` steps. | Reuse that page/endpoint for validated worker evidence, with separate version-2 receipts bound to the worker bundle hash. |

## Verification recorded

Counts below describe their individual runs and **must not be added together**;
the focused bank regression overlaps the isolated runner.

| Check | Result |
| --- | --- |
| Existing isolated PostgreSQL runner, extended with bank ingestion | **140/140 PASS**, 10 files |
| Focused bank regression | **35/35 PASS** |
| Frontend QA/list regression | **10/10 PASS**, 2 files: 8 QA + 2 existing Invoice-list checks |
| API and frontend TypeScript checks | **PASS** |
| API and frontend builds | **PASS** |
| Bundled real-worker preflight as `bizpr81preview` | **PASS**, all 11 evidence checks true |

The worker preflight used **synthetic actor `po14-owner@qa.invalid`**. It proves
the worker and SQL execution under the runtime OS account; it is **not evidence
of a real Owner session or browser acceptance**.

The preflight read back debit **100000.00** and credit **100000.00**, one approval
audit, one `CANONICAL_POSTED` audit, and one finalization audit. Matching and
allocation approval have their own audit actions. Replay created no duplicate
money or posting audit. Audit failure rolled back the allocation/journal writer.
The worker recorded five suppressed notification intents, sent zero external
notifications, and removed its disposable database successfully.

## Isolation and limits

- PO #14 / Shipment #8 / GR #6, supplier, account, and COA are synthetic
  reference fixtures in disposable PostgreSQL. The existing business PO #14 is
  not modified.
- Sheet transport is explicitly `synthetic_fixture`. The importer/parser and SQL
  writer are real; live Google credentials, a supplier attachment upload, and a
  real bank statement fetch are not established by this evidence.
- The CLI runner uses temporary localhost PostgreSQL instances. The browser
  worker bootstraps only from `127.0.0.1:55495/finance_approval_qa`, creates a
  uniquely named `po14_bank_ingestion_qa_<12hex>` database, and deletes it before
  returning success.
- The worker receives the actor only from the authenticated parent. It creates
  no session/cookie. Its bundle excludes business DB resolvers, original HTTP
  auth, Google transport, and outbound notification implementations. Service
  activity and suppressed notification intents stay in its disposable DB.
- These tests write no transactions to the CST-DEV business database or PROD,
  and initiate no bank transfer. Reduced fixture schemas are not a claim of
  complete production-schema, permissions, or RLS parity.

## Reproduction and principal code

```sh
scripts/qa/run-po14-isolated-marketplace-e2e.sh
node scripts/qa/build-po14-real-worker.mjs
```

The browser worker must be invoked by the gated existing endpoint after session
verification; a CLI actor is only test input.

Principal evidence sources: `marketplaceBankIngestionRealPg.test.ts`,
`marketplaceBankImportProvenance.ts`, `marketplaceInvoiceBankStatusAdapter.ts`,
`marketplacePaymentFinalization.ts`, `bank-reconciliation.ts`,
`dev-finance-po14-e2e-qa.ts`, and `scripts/qa/po14-real-worker.ts`.

## QA-only deployment and browser acceptance

QA deployment verified on **25 November 2026, 20:39 WIB**. The existing
`cst-bizportal-finance-approval-qa.service` now serves the new bundle on its
existing port 19882. Only the exact PO14 page, its separate `/po14-qa-assets/`
assets, and the existing PO14 QA API route use that service. The main Finance
runtime remains on port 19881. The PO14 API timeout is 155 seconds to allow
worker cancellation and database cleanup; the other API routes are unchanged.

Verified page: <https://finance-pr81.72.61.210.205.sslip.io/finance/po14-e2e-qa>.
The browser currently shows the normal login form, without an authenticated
Owner session. No version-2 PASS receipt has been created by this deployment.

| Required observation | Recorded result |
| --- | --- |
| QA runtime candidate / worker SHA256 | Release `/opt/cst-po14-real-qa-20261125`; hashes below |
| Existing QA-only runtime deployment and HTTP health | PASS: QA page, its JS asset, Finance page, and liveness HTTP 200; unsigned QA API HTTP 401 |
| Real signed Owner/Super Admin session, CST scope | Pending sign-in / browser verification |
| Existing `/finance/po14-e2e-qa` execution and version-2 receipt | Pending real-session execution |
| Receipt replay with no duplicate run/audit | Pending real-session verification |
| Postflight: disposable DB removed; business runtime retained | PASS: zero leftover worker databases; zero v2 receipts/audits before Owner execution; business process PID and API bundle hash unchanged |
| Business bank endpoint exposure | Existing Nginx catch-all retained; GET `/api/bank-reconciliation/1/post` returns HTTP 404 |

Deployment hashes:

```text
QA API:  dcd5baeca5063d590c3859587af95e0115432406f33f235d6b1e55fb230a02d4
QA HTML: 603aad2e098022e1d08263720b0edc7c671f4648874a1754dba069b54316e953
Worker:  2281f5f1ea02f3b1782e68523e0c808eb0ad56c79be53378feefbeda40c1e22a
Business API, unchanged:
0a1f7a291e68c2b4fad3e6a6bce465c3cb5076516a7b412cb8dea8c712a7baa8
```

The new receipt schema was applied only to the existing localhost QA container,
whose PostgreSQL port is published on `127.0.0.1:55495`. Background Fleet and
reconciliation jobs are explicitly disabled on the QA service. Existing
`SIMULATED` receipts are preserved and ignored by the new contract. No fresh
business-table inventory was taken; unchanged business transaction counts from
earlier reports must not be presented as a new measurement.

The staged release retains the previous Nginx site text and deployment manifest.
Rollback removes only the QA service's `40-po14-real-qa.conf` drop-in, restores
that Nginx site backup, validates Nginx, and restarts the QA service. It does not
require restarting the main Finance service or deleting previous QA receipts.

Until those observations are recorded, **full through-app Owner E2E remains
unverified**. No business payment release or PROD deployment is established by
this document.
