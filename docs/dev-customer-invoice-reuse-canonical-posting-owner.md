# Customer Invoice DEV — selective reuse of the original posting owner

**Status: SOURCE-ONLY / NO-GO for live posting.** This is not a second Accounting engine, and does not authorize PROD, a DEV migration, secret rotation, or active API deployment.

## Original source and parity

The existing legacy Canonical Posting Engine belongs to Travelintrips/CST-BIZPORTAL/.upstream-cst-super-app under artifacts/api-server/src/lib/accounting.ts and artifacts/api-server/src/lib/posting-engine.

The same canonical accounting table schema already exists unchanged in bizportal/bizportal-app. SHA-256 of canonical and original lib/db/src/schema/accounting.ts:
a2c8ca32b00aba24eb48fa4e07f4ea468aefa014e2147fc9d4f70879629d2c2b

The original backend lacked 16 supporting source modules in the newer canonical repository. This candidate reuses them from the original source; there is NO import by the active API entrypoint.

Original CanonicalPostingEngine SHA-256:
edac01a988b6a5f241f5e3e50678ef6da6b8e920e0d712a7c4a60de49e3243f4

Original validators SHA-256:
4cf0587e2c0e931a533155818e90ada33b14934e1594f9c50f94896cc87870df

These two owner modules remain byte-identical to the legacy originals.

## Essential transaction protection

The existing accounting.ts used to launch global-db postLedgerEvent, checksum, outbox, and spot-check work while a caller-owned transaction had not committed. Those effects might run even when the invoice transaction later rolls back.

This source-only candidate preserves the original root-DB behavior, but suppresses those global effects when an existing caller-owned transaction is supplied. It also fails closed instead of falling back to a different DB connection after a failed journal sequence UPSERT or attempting a global enum migration after an aborted caller transaction.

The caller must later implement reliable post-commit effects; do not infer audit completeness merely from this patch. Do not call the old global postSalesInvoice wrapper from the Customer Portal.

## Evidence completed

- Original retained engine compiles against the existing canonical Drizzle schema with an isolated temporary compatibility shim.
- The 16 missing source modules staged, canonical source TypeScript PASS.
- Six governance/transaction source tests PASS.
- Full credential-free canonical API regression: 926 executed tests PASS; 54 skipped by suite configuration.
- No new posting SQL deployed, no GCP secret/database mutation, no real customer invoice, no WhatsApp or Gmail send, no PROD change.
- One direct original-engine runtime probe was NOT passed: temporary bundling lacked the appropriate pino/drizzle-zod package resolution. No journal transaction was executed by that probe, and no E2E PASS is claimed.

## Mandatory conditions before activation

1. Package existing owner modules with deterministic dependencies, independent of the old filesystem repository.
2. Run the owner on the SAME PostgreSQL transaction/client as the existing Customer Portal issuer, or move the entire issuance operation to the canonical Accounting owner. A separate HTTP DB connection is not atomic.
3. Obtain company 1 or 3 from authorized server state and exact existing Accounting configuration; no shared credential or implicit company fallback, and no auto-seeding historical financial tables.
4. Verify period locks, active/postable company-owned AR/revenue accounts, correct sales journal, balanced original GL lines, unique same-company sales_invoice posting, single AR projection, and replay idempotency.
5. Explicitly fail taxable invoice issuance until verified tax/PPN lines and journal posting are fully atomic. Original CanonicalPostingEngine v1 rejects posting with its taxes array.
6. Publish reliable, idempotent ledger/audit/outbox effects only after COMMIT.
7. Connect the approved legitimate owner (NOT a synthetic test callback) to Customer Portal Draft PR #206; preserve Draft PR #205 posted-AR source proof.
8. Prove genuine signed Super Admin HTTP issuance on DEV, company1 and company3 isolation, rollback and zero external messaging. Keep both DEV feature flags OFF until all gates pass.

No historical invoice numbers/dates, posted GL or bank matches should be fabricated just to claim PASS. Preserve the existing Vendor Invoice, Payroll, Fleet, Sport Center and other already-PASS behavior.
