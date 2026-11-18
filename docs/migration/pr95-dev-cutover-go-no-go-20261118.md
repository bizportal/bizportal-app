# PR #95 — CST BizPortal DEV cutover gate (2026-11-18)

**Decision: NO-GO for DEV cutover or PROD activation.** This is an evidence and rollback checklist, not permission to deploy. Canonical target: `bizportal/bizportal-app`. Historical repository: `Travelintrips/CST-BIZPORTAL`. PR #95 is still Draft; preserve already-PASS code and do not silently replace the running DEV site or Hostinger PROD.

## 1. Verified candidate gates

- Bank Writer disposable PostgreSQL CI, Reconciliation, QRIS, Payroll PostgreSQL HTTP and Release Gate were all successful at prior PR head `f25f2305bc14`. Recheck **all five checks on the current exact SHA** after every commit.
- PR95 signed DEV OTP flow was exercised with real application HTTP endpoints, signed session, DB verification and source-journal candidate in disposable PostgreSQL; SMTP delivery was MOCKED.
- The canonical vendor-invoice-payment-batch route has a DEV-only, explicit `source_journal_reuse=true` branch. `PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV` must stay **OFF** until the live DEV-only acceptance gate passes.
- A bank-mutation source journal must match its actual company, invoice, account-to-COA and posted Accounting journal. No synthetic bank mutation or second journal is acceptable.

## 2. Read-only CST-DEV blockers (18 Nov 2026)

- Company 1 Invoice #7 has a posted Bank Disbursement #2, source Accounting entry #314, amount **Rp31.694.392**. No exact-amount authenticated bank OUT mutation, no linked mutation for journal #314, and no active allocation were present in inspected CST-DEV.
- `public.bank_sheet_configs` Company 1: config #2 (`mutasi dev`, Mandiri Ciputat) is **inactive**, last sync 11 Sep 2026; config #3 (`kas besar`) was active but last sync failed 24 Sep 2026 with an invalid Google service-account JSON diagnostic. Both point to a common Google Sheet but different tabs.
- The connected Google account currently returns **403 permission denied** when trying to read that configured spreadsheet. This is an external access blocker, not a payment SQL failure.
- Existing Google Sheet importer `src/lib/bank-sheet-sync.ts` derives OUT from columns and headers; either debit or credit can represent money out. Accept one exact positive side and one exact zero side only, match `amount`, and independently verify bank COA and source journal. Do not impose one globally hard-coded debit/credit orientation.

## 3. Mandatory gates before any DEV cutover

1. **Source ownership:** verify Google Sheet owner and sharing for the explicitly intended DEV service identity; fix access in the provider UI without sending credentials into chat. Do not enable or sync a stale feed merely because permissions are repaired.
2. **Configuration:** verify intended bank-account mapping, `account_type`, correct tab, company isolation, and import direction. Check source data preview for the target date/amount/reference; compare independently to bank statement evidence.
3. **Read-only import rehearsal:** use a copy/export or isolated database to exercise existing importer. Prove header orientation, deduplication by canonical key, exact amounts, incorrect-company exclusion, and no accidental updates to existing posted rows.
4. **Canonical DEV release candidate:** deploy the exact reviewed SHA to an isolated DEV-only preview (never change active PROD). Verify application environment identity, DB project ID and signed-OTP DEV session conditions; keep source reuse flag OFF initially.
5. **Real SMTP:** verify actual OTP receipt by the authorized Super Admin using the already-existing auth route, session binding and revocation. Never disclose OTP in logs or chats.
6. **Authentic reconciliation:** only with a real bank OUT mutation and the approved company/invoice/account/amount/reference, exercise source journal reuse in controlled DEV. Check accounting_entries count unchanged, exactly one payment_matching_group/active allocation, one approved match, bank_mutations.posted, and correct GET Vendor Invoice outstanding state. Verify rollback and replay protections. Without an authentic mutation, mark this gate **BLOCKED**, not simulated PASS.
7. **Cross-functional parity:** reconcile the 66 changed, 160 canonical-only and 193 legacy-only tracked files from the pinned parity audit. Mark each material runtime route (HRD/OCR, Payroll/kasbon, Finance, Vendor AP, QRIS, Customer Portal) as adopted, superseded or intentionally retired; verify route registration, authorization, cross-company isolation and existing PROD feature flags. The old blob inventory alone is NOT semantic parity.
8. **Rollback rehearsal:** capture current exact active DEV SHA/config and backup evidence, rehearse traffic rollback and `APP_ENV`/DB target checks. Do not rollback with destructive schema operations. Document reviewer approval before any cutover.
9. **Release:** only after current SHA five CI checks SUCCESS, signed OTP SMTP, genuine bank-source E2E, multi-module parity, and rollback rehearsal are PASS may a separate DEV cutover decision be made. PROD remains independently gated.

## 4. Explicit stop conditions

No live DEV or PROD bank-mutation insert/update, no fabricated bank statement, no second AP-bank journal, no copied password/service-account JSON, no enabling inactive bank source, no Hostinger Deploy, and no PR merge solely to turn this checklist green. Stop and report the missing evidence or external permission owner.

**This report does not certify that the current DEV environment is ready for migration.**
