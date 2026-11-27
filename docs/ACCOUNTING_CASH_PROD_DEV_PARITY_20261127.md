# Accounting & Cash/Bank PROD–DEV Parity: Reuse, Not Rebuild
**Audit date:** 27 November 2026 (CST-DEV). **Status: cutover / cash posting NO-GO pending authenticated parity.**

## Decision
Accounting already operates in Hostinger PROD. The work in DEV is **not** a mandate to build a second ledger. Bring the canonical DEV runtime to the same **observable UI/API/authorization/accounting contract** as the operational PROD application, then adapt Kas Besar SC as a source of an existing Accounting transaction. Keep its SHA/content-review/revocation audit safeguards, but **never mount an independent journal writer** under `sc-future-cash-preview` or `cash-ledger-postgres-disposable`.

## Deployed baselines and provenance
- The previously inspected Hostinger hPanel PROD source in [Issue #40](https://github.com/bizportal/bizportal-app/issues/40) was `Travelintrips/CST-BIZPORTAL@647f2778`, branch `main`, on **14 November**. The authenticated hPanel Git mapping **has not been re-verified** during this 27 November audit; a file date alone does not prove repo or commit.
- Read-only HTTP fetch on 27 November: PROD `https://bizportal.cstlogistic.co.id` serves `/assets/index-CGqjpAPz.js` modified **2026-11-14 13:41:38 UTC**. DEV `https://dev-bizportal.cstlogistic.co.id` serves `/assets/index-DMpcs0RV.js` modified **2026-11-27 08:32:17 UTC**. Both root and `/api/health/live` HTTP 200; unauthenticated `/api/accounting/entries` HTTP 401 on each. These are **availability/auth** facts, not behavioral parity or exact deployment-SHA proof.
- The DEV main bundle references the `sc-new` feature; the PROD main bundle does not. This shows intentional frontend differences, not authorization to change PROD.

## Existing upstream posting engine is a reference, not a deploy target
The legacy repository `Travelintrips/CST-BIZPORTAL@647f2778` contains a **separate archived source tree** at `.upstream-cst-super-app/artifacts/api-server/src/lib/`:
- `posting-engine/CanonicalPostingEngine.ts` and `posting-engine/index.ts` expose a documented single posting entrypoint `getPostingEngine().post(...)`, delegating to the existing `postEntryWithClient` function rather than recreating balance/idempotency logic.
- `accountingPostingService.ts` serves as an Accounting Hub service, referenced by archived `routes/accountingHub.ts`.

**Do not mistake archived files for active Hostinger code**: the active `artifacts/api-server/src/lib` of the legacy deploy source and the canonical standalone repository do not contain these engine files. This is a concrete reuse candidate and migration reference, **not** authority to copy it wholesale or run its writers. First locate the currently executing PROD service and verify its auth, journal/period lock, source replay and ledger ownership contract.

## Canonical code reused today
- `routes/accounting.ts`: GET journals and entries, chart of accounts and GL reports from `public.accounting_entries`, `public.accounting_entry_lines` and `public.accounting_general_ledger_v`.
- `routes/bank-reconciliation.ts`: already writes canonical `accounting_entries` and `accounting_entry_lines`, locks matching bank mutations, enforces balanced journal and idempotent post. **Its private `postBankMutationCanonical` function is specific to bank mutations; it is NOT a generic cash posting entrypoint. Never call it on a fabricated bank mutation to post Kas Besar SC.**
- `routes/sc-future-cash-preview.ts`: dedicated DEV signed Owner/Super Admin, document verification, substance review, voucher OTP and REVOKED evidence audit. `postingAllowed:false`; no journal posting endpoint.
- `lib/cash-ledger-posting.ts` and `lib/cash-ledger-postgres-disposable.ts`: pure planning and QA-only `cash_qa` PostgreSQL adapter. Six tests passing in isolated PG17 prove math/replay/rollback, **not** canonical operational posting or PROD parity.

## Source-level frontend → standalone-backend contract gaps
These are **static file and route-presence findings**, not authenticated runtime failures and not proof that PROD currently uses a particular implementation.

| Existing frontend request or backend feature | Canonical standalone API source inspected | Result |
|---|---|---|
| GET `/api/accounting/journals` | `routes/accounting.ts` | PRESENT |
| POST `/api/accounting/journals` (journal master UI) | `routes/accounting.ts` | **MISSING** |
| GET `/api/accounting/entries` | `routes/accounting.ts` | PRESENT |
| POST `/api/accounting/entries` (manual GL UI) | `routes/accounting.ts` | **MISSING** |
| PATCH `/api/accounting/entries/:id/status` (status UI) | `routes/accounting.ts` | **MISSING** |
| POST `/api/accounting/entries/:id/reverse` (reversal UI) | `routes/accounting.ts` | **MISSING** |
| POST `/api/accounting/other-transactions` | `routes/accounting.ts` | **MISSING** |
| Existing bank reconciliation journal posting implementation | `routes/bank-reconciliation.ts` | PRESENT, bank-mutation scoped |
| GET `/api/cash-bank/accounts` | `routes/cash-bank-read-parity.ts` | PRESENT |
| GET `/api/cash-bank/petty-cash` | `routes/cash-bank-read-parity.ts` | **MISSING** |
| POST `/api/cash-bank/petty-cash` | `routes/cash-bank-read-parity.ts` | **MISSING** |
| PATCH `/api/cash-bank/petty-cash/:id/{approve,complete}` | `routes/cash-bank-read-parity.ts` | **MISSING** |
| Kas Besar SC DEV preview (no posting) | `routes/sc-future-cash-preview.ts` | PRESENT, restricted to DEV |

The API route inventory in this repo was searched in addition to inspecting the named files. Some legacy operational functionality may live in a different service or a deployed commit; resolving **the running backend's identity** is the first parity action.

## Read-only CST-DEV Accounting data model
- Existing `company_bank_accounts.id=18` for Company 1 is **Kas Besar SC**, account type `cash`, active, linked to existing `chart_of_accounts.id=75839` / code `1-1011-CST` (active, postable, non-header). **Reuse this record; do not create a duplicate cash account or COA.**
- Existing Company 1 journal master includes bank `BNK-CST` (#4), QRIS `QRIS-CST` (#5), cash `CSH-CST` (#6), general `GEN-CST` (#7). Whether journal #6 is the appropriate **Kas Besar** journal requires mapping review; do not assume based on the word “cash.”
- The shared Account­ing tables already contain Company 1 entries: **68 draft, 162 posted, 1 voided**, with **568 journal-entry lines**. Do **not** infer these are Kas Besar SC transactions.
- The only current Kas Besar SC document is a revoked Rp10,000 NPWP attachment; **no real cash receipt is eligible**. Keep historical approvals, audit and NO-GO; do not reuse.

## Exact next gates (DEV first, no rebuild)
1. **Identify true PROD runtime/backend** from authenticated hPanel: repository + branch + release SHA + service root + rollback. No secret values in issue, logs or screenshots. Existing November 14 record is not enough to assert the current state.
2. **Establish complete route and payload parity** for Accounting journals, manual entries, status/void/reverse, other transactions, Cash & Bank accounts and Petty Cash. Compare the actual PROD behavior **read-only or with historical safe records**, and canonical DEV. Do not send POST/PATCH/DELETE to PROD for parity probing.
3. **Reuse the existing operational ledger contract** and tables. Port the minimum missing API implementation/authorization into the canonical DEV code only after identifying its source. Keep Company 1 isolation, Owner/Super Admin signed OTP for Kas Besar SC, source UUID, exact-cent amount, counter-COA validation, evidence and revocation checks.
4. Exercise a **disposable isolated PostgreSQL** E2E through the *chosen canonical Accounting adapter*, not only `cash_qa`. Verify atomic journal, 2 balanced legs, reversal, replay, concurrent requests, failure rollback, and no direct writer duplication.
5. Test DEV with a **genuine** new cash receipt. Do not fabricate, use the REVOKED NPWP, treat a mere hash as substance review, import historical Config #5, or post to PROD. Keep cutover to `bizportal/bizportal-app` BLOCKED until existing PROD behaviors are proven.

## Repeatable report-only inventory
Existing `node scripts/audit-prod-parity.mjs` has been extended with Accounting/Cash & Bank API markers. Default mode/JSON reports missing contracts **without failing CI or changing anything**. `--strict` remains an opt-in nonzero exit for missing markers and is not a substitute for authenticated behavior tests. Findings are linked to [Issue #40](https://github.com/bizportal/bizportal-app/issues/40), [Kas Besar SC #218](https://github.com/bizportal/bizportal-app/issues/218), and [evidence revocation #278](https://github.com/bizportal/bizportal-app/issues/278).
