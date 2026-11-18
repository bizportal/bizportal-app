# PR #147 / CST-DEV — Bank Sheet migration NO-GO audit (2026-11-18)

## Scope and evidence

- **Repository:** bizportal/bizportal-app; **environment:** CST-DEV Supabase project `xssrfshdrtdfupgqwfdw`. All database queries were SELECT only. No PROD or live DEV writes performed.
- Live Hostinger DEV frontend responds HTTP 200 and health/live responds HTTP 200; without an authorized session, `GET /api/bank-reconciliation/sheet-configs?company_id=1` currently responds **HTTP 503**, consistent with source SQL referencing the missing `bank_sheet_configs.bank_account_id`.
- `public.bank_sheet_configs` has two existing Company 1 rows: ID 2 `mutasi dev`, tab `mutasidev`, inactive, uniquely account-number-mapped to Company Bank Account 17; ID 3 `kas besar`, tab `kasbesar`, active, uniquely mapped to account 2. A company-scoped read-only compatibility query retrieves both.
- Current DEV table **does not have** `bank_account_id`. Existing canonical `artifacts/api-server/scripts/ensure-bank-sheet-account-isolation.sql` does add this column, an active-account constraint, a unique company/Sheet/tab index, and a `bank_mutations.sheet_config_id` FK with validation.
- Pre-migration constraint readiness SELECT found **21 orphaned bank mutations** with `sheet_config_id=4` while Sheet config 4 is missing. **7 bank mutations have `status='posted'` and a `journal_entry_id`, but their Accounting journal evidence is inconsistent: five referenced `accounting_entries` rows are `draft` (source `sport_center_booking`), while two referenced journal IDs do not exist. None of these seven has a verified posted Accounting entry.** Of 21 historical orphan rows, 15 have a NULL bank_account_id and 6 carry account ID 17. The recorded dates span June–August 2026; these records cannot safely be assigned to Sheet config 2/3 by inference.
- Audit log lookup for source Sheet config 4 yielded no direct matching ownership history. Do not fabricate this missing configuration, change historical bank mutation `sheet_config_id`, or remove posted ledger references.

## Changes and release gates

1. Retain existing config rows; repair list/test read paths via company-scoped, uniquely matching stored bank number to existing account. Never insert a duplicate Sheet config to solve `0 koneksi`.
2. Show an API error rather than treating failed GET as an empty list; disable the Add button while API state is unknown.
3. Require actual signed DEV session (or authorized existing DEV session) and company scope on all Sheet configuration read, test, edit/delete and sync endpoints. Do not attempt sync without explicit authorized test.
4. Existing migration SQL now has a **pre-DDL fail-closed guard** that raises `BANK_SHEET_CUTOVER_BLOCKED` if orphaned `sheet_config_id` references exist. The transaction must roll back before any schema changes. Do not run this migration on live CST-DEV until the posted historic provenance is independently verified and resolved.
5. Preserve PROD and PR #95 untouched. No Site Hostinger deployment or migration has been performed; PR #147 is a candidate.

## Explicit evidence required for GO

- [ ] Resolve and document the 21 orphan references to missing `sheet_config_id=4` without modifying posted entries improperly; verify account, company, original Sheet source, immutable journal and rollback.
- [ ] Rehearse `ensure-bank-sheet-account-isolation.sql` on a disposable PostgreSQL clone/snapshot and verify the unique/FK/check/trigger conditions and idempotence.
- [ ] Authorized DEV deployment of exact reviewed PR #147 commit only; verify runtime repo SHA, branch and database target. **No PROD deployment**.
- [ ] With authenticated CST Super Admin session, GET `/api/bank-reconciliation/sheet-configs?company_id=1` returns exactly 2 configs, and `mutasi dev` remains inactive.
- [ ] Test existing Sheet connection by read-only `POST /api/bank-reconciliation/sheet-configs/2/test` using signed session. Confirm Service Account identity, spreadsheet access, and tab `mutasidev`; do not click Sync.
- [ ] Verify unauthorized GET/POST access returns 401 and company-crossover access returns 403. No bank import or data write.
- [ ] Verify authentic bank evidence and entire finance E2E (without double posting) plus cross-module parity and DEV rollback before any overall BizPortal cutover.

**Forensic addition:** read-only grouping of Company 1's bank mutations with `journal_entry_id` confirmed these seven orphan-linked mutations are the entire observed set of posted bank mutations with a journal reference; five have draft Accounting entries and two have missing entries. Do not call them seven *posted journals*. Canonical SHA256 re-computation from current row date/description/debit/credit fields with account-scope candidates 0, 1, 2 and 17 matched none of the 21 stored `canonical_key` values. That negative result does not establish the original Sheet/account identity: historical source normalization or row contents may have changed. Recovery requires original account/Sheet provenance or verified backup, not inference from an unverified hash.

**Current decision: NO-GO.** CI success is not a replacement for actual DEV runtime and financial provenance.
