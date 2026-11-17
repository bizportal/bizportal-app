# CST-DEV Customer Invoice -> original Accounting engine -> AR

**Status: synthetic in-process E2E PASS; source candidate only, NOT deployed.**

## Original owner, same client

Existing Customer Portal Draft PR #206 implements an OFF-by-default trusted server-only callback on the existing mark_invoiced handler, inside its current PostgreSQL transaction. This candidate adapts that callback to the ORIGINAL CanonicalPostingEngine via getPostingEngine().post(request, drizzle(transactionClient)). It uses the exact same client. It creates no second journal writer, DB project, credential, or runtime server.

The original engine enforces period, balance, company-owned COA, journal sequence, draft-to-posted transitions, and source idempotency. This adapter validates the locked Sales Invoice row, company1/3, configured company sales journal, AR account, revenue account and exact amounts. Since the Customer Portal response omits tax_amount, the adapter obtains tax from the locked SQL source. Positive PPN/tax must FAIL CLOSED until an atomic tax posting path is verified.

Required environment flags (OFF by default):
- CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=true
- CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=true
- APP_ENV=development

No request body can supply the backend callback. No PROD activation is allowed.

## Verified actual DEV synthetic integration

Using the real exported Customer Portal mark_invoiced handler AND original CanonicalPostingEngine, a single verified PostgreSQL17 CST-DEV session, one outer BEGIN and ROLLBACK, and mocked notifications:

For BOTH CST company1 and Diva company3:
1. Missing legitimate posting owner -> issuer rejects with 503 equivalent; invoice remains to_invoice.
2. The original engine (NOT a fake posting fixture) posts a real, balanced journal into the test transaction using existing company Accounting settings.
3. The original security-invoker AR proof view matches the exact journal and invoice; original deferred AR trigger creates one receivable.
4. Replay does not post a duplicate journal or AR.
5. Outer transaction ROLLBACK; no real company data remains.

Exit code 0. Independent Supabase postflight: QA Invoice=0, QA journal=0, QA AR=0, QA connections=0; original AR issuer actors and protected PO14 unchanged. Temporary CJS bundle, test file and node_modules links removed from the test machines. Active services stayed HTTP200.

Permanent adapter regression tests: 16/16 PASS; TypeScript PASS.
Original owner source-only migration PR135: 926/926 executed API tests PASS (54 intentionally skipped), 6/6 source-side transaction safeguards PASS.

## Remaining NO-GO before runtime activation

- Make a pinned, reviewed, deterministic in-process release package of the existing owner. The transient CJS bundle and symlinks from the proof are not a deployable package.
- Wire it through a GENUINELY authenticated signed owner/Super Admin HTTP route. The synthetic test user was not an authenticated HTTP session.
- Make the original owner's post-COMMIT audit/ledger/outbox effects reliable and idempotent; suppress all out-of-transaction writes before COMMIT.
- Verify all PPN/tax invoice cases. Currently the original engine v1 rejects taxes; this adapter refuses nonzero tax.
- Cover company isolation, concurrent issuances, process-restart replay, closed periods and fail-closed rollback.
- Do not alter historical Invoice metadata or bank/payments, do not activate in PROD, do not emit real WA/email, and do not change default OFF flags until the gates have passed.

## Provenance

BizPortal canonical owner source = Draft PR #135.
BizPortal same-client adapter = this stacked Draft PR.
Customer Portal issuer = Draft PR #206.
One existing Supabase DEV project xssrfshdrtdfupgqwfdw and one existing GCP Finance bundle.
