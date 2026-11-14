# HRD Stage 4 — company-scoped document metadata and audit (READ ONLY)

Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40).

## Existing PROD implementation
The legacy `Travelintrips/CST-BIZPORTAL` endpoint `GET /hrd/employees/:id` reads an employee, profile, documents and document audit history under the `bizportal_hrd_prod` role and company-scoped RLS. The historical route includes private `extracted_data`, `verified_data`, audit `approved_data`, and other identity information. Do not expose these in this first canonical metadata slice.

## Scope of canonical stage 4
- `GET /api/hrd/employees/:id?companyId=N`, **OFF** unless `APP_ENV=production`, `HRD_CANONICAL_READONLY_ENABLED=true` and separate `HRD_CANONICAL_DOCUMENT_METADATA_ENABLED=true`.
- Existing signed BizPortal session, active database user, designated CST Owner or Super Admin and explicit company authorization are mandatory.
- Uses `withHrdCompanyReadOnly`: `BEGIN READ ONLY`, verified `SET LOCAL ROLE bizportal_hrd_prod`, transaction-local `app.hrd_company_id`, rollback and discard-on-uncertain-transaction.
- Reads only minimal directory identity, document status/type/MIME/confidence and timestamps, audit `document_id` / `action` / timestamp, and a boolean indicating whether a private profile row exists. Both company_id and employee_id are required in all private-table queries. Documents and audit are capped at 80 records each, as in legacy; **not a complete unlimited history**.
- Does **not** select `extracted_data`, `verified_data`, `approved_data`, `storage_path`, `warnings`, audit actor or any raw document bytes. Returns no signed URLs, OCR results, full verifiedProfile, status write, photo upload, preview, payment, or document verification capability.
- No SQL schema migration or financial/employee mutation.

## Verification and limits
- Mock HTTP tests: default 404, active session and company checks, malformed ID, 503 with error redaction, exact private-table company/employee filters, and negative writer/PII assertions.
- Run test/typecheck/build and review in canonical. Check actual PROD column permissions and RLS with **READ ONLY** queries returning only row counts—no personal document contents.
- This is partial source parity, **not full OCR/document workflow parity**. Private storage object security, upload/verification, image previews, status-change writer workflow, Payroll PROD and group allocations remain separate blockers under Issue #40.
- Keep all feature flags OFF and Hostinger PROD on its current source until full approved cutover.

