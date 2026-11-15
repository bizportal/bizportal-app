# Isolated Finance/Gmail review gate — 14 November 2026

**Repository tested:** `bizportal/bizportal-app`; baseline test branch `test/canonical-dev-parity-combined-20261114` (PR #23). **Live DEV comparison source:** `Travelintrips/CST-BIZPORTAL` at `2705d4c720fb7aa5d34f72ba60ef55be4dd91d7d`. This is an evidence document, **not approval** to change financial data or switch Hostinger source.

## 1. Purchase Workflow authorization matrix

The production-mode route middleware in canonical `artifacts/api-server/src/routes/purchase-workflow.ts` accepts `admin`, `owner`, and `super_admin`; it rejects finance/accounting/viewer. Live DEV source `2705d4c` only accepted `admin`. Canonical candidate's DEV-session middleware also admits these three roles, but its signed OTP DEV-bridge compatibility requires further E2E scrutiny.

The associated `purchase-auth.test.ts` now characterizes roles through a signed cookie on an unmatched, **non-mutating** purchase path. A permitted role falls through with 204 (not a successful financial operation); forbidden roles return 403. This **does not authorize** an expanded role matrix, only records that the code behaves differently from active DEV.

**Open decision:** preserve strict active-DEV `admin` permissions until the owner confirms that `owner` and `super_admin` should also operate these financial routes, including any elevated approval boundaries. No role behavior was changed in this gate.

## 2. QRIS / Bank Reconciliation

Existing canonical regression tests include posted-journal balance and final-match protection, QRIS gross/MDR sources, reset history, Rule AI review, and bank-source integrity. Selected baseline run: 9 test files / **69 passing**, executed in isolated candidate checkout without network-backed writes or bank transaction execution.

New source-contract tests check `qris-canonical/prepare` requires an actor before `pool.connect()`, maintains begin/commit/rollback and connection release; payment date update checks date validation and company context; vendor invoice batch rejects malformed/duplicate allocations before DB transaction. These tests are **source/static contracts** and not proof of real posting correctness or RLS.

The shared `getApprovalActor` currently admits `admin`, `owner`, `finance`, `accounting`, `accountant`, and `super_admin`, substantially broader than a Super-Admin-only financial approval policy. **Do not broaden or activate financial mutations based on these tests.** Review the action-specific permission and maker/checker matrix before any DEV live transaction. No QRIS reset, settlement, bank match, post or journal change was executed.

## 3. Gmail invoice candidate review (source audit only)

**Active DEV route (not yet ported):** `POST /recon-classification/invoice-sources/gmail/candidates/:id/review` accepts `decision=reject|restore` after `requireFinanceAdmin` and a company ID lookup. Underlying implementation `reviewGmailInvoiceCandidate` in the active legacy `gmail-invoice-candidates.ts` performs one conditional SQL UPDATE, restricted by `id`, `company_id`, `vendor_invoice_id IS NULL`, and allowed prior status; rejects require a reason of 10–500 characters.

A successful reject sets `status='rejected'`. Restore recomputes the status using the supporting-tax-document filename, OCR state/amount/confidence. Every decision appends `source_review_history` in `extracted_json`. A disallowed transition or already-imported candidate raises a 409 conflict. It does not delete Gmail messages, pay invoices, or change ledger rows in this function.

**Blocking authorization gap:** the active shared `requireCompanyScope` helper accepts an actor with `companyId=null` and any positive caller-supplied company ID. Therefore, porting this POST route without adding a null-scope guard could permit a non-privileged unscoped actor to review another company's candidates. It is intentionally **not ported or enabled**. A future patch must reject unscoped non-privileged actors and add HTTP tests for cross-company, duplicate reject, restore-only-from-rejected, already-imported, and idempotent 409 cases using mocks.

## 4. Operational stop conditions

- The actual Nginx-served Hostinger DEV checkout remains separate from candidate PR #23; do not overwrite it.
- PR #21 geofence, #22 Gmail proposal GET, #23 combined parity and #28 payment-tenant guard are all separate review work. Do not double-merge stacked candidates.
- **No real Purchase posting, QRIS mutation, bank settlement, Gmail review, outbound email, database DDL, PROD access or journal operation** was part of these tests.
- Browser/session E2E, applicable Supabase actor permissions, and full behavior parity with Accounting and QRIS remain requirements before a cutover.
