# PR147 — Immutable Sheet 4 historical custody, CST-DEV source-only

**Scope:** Supabase CST-DEV `xssrfshdrtdfupgqwfdw`, company 1 (CST), and source-only bank Sheet configuration GET. This is **not** a correction, migration, approval to post journal entries, or permission to deploy to PROD.

## Evidence observed live on 20 November 2026

Historical `public.bank_mutations.sheet_config_id = 4` rows: **21**, all company 1, spanning IDs 26–203. Of these, 14 have no journal reference, 2 reference a nonexistent accounting journal, and 5 reference nonfinal journal entries. Baseline `bank_mutations` all-company total: 54.

The absent Sheet config 4 **does not establish** whether those historical mutations belong to existing Sheet configs 2 or 3; do not assume a source from matching bank number, transaction date, amount, or tenant. The journal states do not permit automatic final posting.

Read-only fingerprints:
- Historical mutation rows: `788613e84e63fc9f8caf33cdd64ffbea`
- Journal linkage and statuses: `981475bc545d0eb37c95394f073ed9e4`
- Current Sheet configuration records: `4e9372d0e973fc52e7fae5a6ca9527ac`

These fingerprints detect accidental changes; they do **not** prove ownership or authentic provenance.

## DEV source-only acceptance without changing history

- Preserve all 21 rows and their original `sheet_config_id=4` values **as-is**. Do not add a fabricated Sheet config 4, reassign to 2/3, null out references, delete rows, make up journal links, mark drafts posted, or create compensating entries.
- Keep Sheet configuration **write, sync, import, and journal-post paths disabled** on the isolated PR147 source-only candidate. The read-only config GET must use a signed Super Admin or authorized company-scoped Finance actor and the restricted CST/Diva RLS principals, never the OTP/shared database pool.
- Do **not** execute pending schema migrations or FKs requiring all historical Sheet links to resolve; they must fail closed on orphan references. This source-only release intentionally does not repair the historical lineage.
- A future provenance remediation is a **separate** task and requires original archived Sheet source, prior change/audit records, explicit accounting owner decision, immutable pre/post snapshot, independent review, isolated replay and separate approval. It must not be a prerequisite silently implemented by PR147.
- Run `pr147-bank-sheet-historical-fingerprint-readonly.sql` before and after *every* isolated runtime test, and require exact equality of counts and all three fingerprints. On any difference, stop with NO-GO and investigate. An API health or CI success alone is never enough.

## Owner decision — 21 November 2026

The Owner explicitly approved the **source-only historical preservation plan**: retain all 21 legacy Sheet-4 bank mutation rows and existing journal references/statuses unchanged for the BizPortal repository cutover. This approval **does not** authorize repairing, reassigning, reposting, migrating, deleting or otherwise changing those historical transactions. Any later reconciliation needs separate provenance evidence and accounting approval.

A fresh read-only CST-DEV check on 21 November 2026 showed exactly 54 total mutations, 21 Sheet-4 legacy rows in one company and 7 journal links. All three baseline fingerprints below are unchanged. Therefore the historical **custody-policy decision is accepted** for the bounded source-only DEV candidate; the underlying unresolved journal links remain intentionally untouched and cannot be counted as accounting reconciliation PASS.

## Remaining release requirements

- Real dedicated reader login + verified TLS, RLS and cross-company isolation are **PASS** using the user-provided Supabase Root 2021 CA. That PASS does not imply signed application-level E2E.
- Exact-head CI and isolated anonymous GET/POST deny tests are PASS.
- A **genuine signed Super Admin** request to isolated API must prove company 1 and 3 authorized GET, 401 anonymous, 403 cross-tenant, 400 missing company, 423 attempted Sheet sync/write, and Finance/Payroll/QRIS scoped read-only behavior. No export of browser cookies, token dumps or privileged bypass allowed.
- Rehearse stopping candidate and restoring original Nginx/API service; keep Hostinger PROD unchanged until Owner explicitly switches after all DEV acceptance gates PASS.

**Decision:** Historical data are **preserved, uncorrected, and excluded from automatic migrated reconciliation** in this source-only PR. The Owner approved this **bounded no-change custody treatment** for source-only cutover on 21 November 2026. This is not an approval of historical accounting reconstruction or a declaration that the full product is ready to cut over.
