# Signed Owner Invoice QA: exact hosted Portal notification RLS and issuer-only routing

**CST-DEV and PROD remain unchanged. Source-only Draft QA.**

## Read-only hosted security finding

- Active Customer Portal Admin count: two.
- Neither active Admin has an active membership to CST (company 1) or
  Diva (company 3) in `portal_company_members`.
- Exactly one active Portal Admin matches an existing canonical BizPortal
  global Owner/Super Admin, while no company-scoped regular staff issuer
  match currently exists for CST/Diva.
- The legacy `notifyAdmins` selects all active Portal Admins. Replaying
  the original DEV `notification-service.mjs` on disposable PG16 with
  two synthetic company Admins emitted **two persisted Admin notifications**
  for each company's `sales_invoice_issued` event. The 24 exact related
  `pg_policies` from CST-DEV allowed this, because Portal Admin status
  itself is visible without canonical BizPortal company authorization.

## Exact source tested

- Original Accounting adapter: official BizPortal PR142. Five immutable
  SHA256 bundle files verified, unchanged `CanonicalPostingEngine`.
- Portal source: **PR232** exact commit
  `4d99a99b24ac3170e68ac2dfc1660c1fbfe5eb2f`, child PR231.
- BizPortal Owner signed-OTP source: PR155 pinned at
  `9ade41f0ab3459841a7e3b154202357f9000496d`.
- The QA script imports real `notification-service.mjs`, not its previous
  test stub. It imports the existing `billing-operations` and verifies
  signed HMAC/Ed25519 and company-scoped original Posting Engine.
- Column permissions are an isolated snapshot of the *actual* CST-DEV
  writer permissions for 22 relevant tables/views and nine sequences.
  The script first proves tax FOR SHARE and two audit-column rights
  are denied before applying only B6/PR157 proposed minimal changes
  **inside a disposable PG16 database**.
- The separate `customer-invoice-hosted-notification-rls-20261119.sql`
  is an exact, read-only snapshot of **24 RLS policies** for
  `portal_customers`, `portal_company_members`,
  `portal_customer_notifications` and `activity_logs`. It has an
  invoice_synthetic database guard and MUST NEVER run on hosted systems.

## Verified change

- Portal PR232 extends original `notifyAdmins` with optional positive
  integer `recipientIds`; absent option preserves legacy behavior.
- For one signed Owner, company-scoped new Invoice issuance only, the
  original authenticated/verified Portal Admin issuer ID is passed.
  Invalid/empty recipient lists fail closed rather than fall back to
  all active Admins. The actual SQL still requires active Admin role.
- Both CST and Diva original PostgreSQL E2E receive **one** persisted
  notification for the verified original issuer; the unrelated Admin
  receives **zero**. Original 3-line GL, PPN, AR, audit, outbox COMMIT,
  replay idempotency and wrong-document rollback remain PASS.
- Feature-OFF Invoice, payments and Marketplace callers are unchanged.
  Four notification service tests cover scoped, malformed, duplicate
  recipient and legacy generic behavior.

## Not claimed; operational NO-GO

- Customer payment submission and status-change Admin notifications still
  use the legacy generic fan-out; they need a separate company-authorized
  recipient design and tests before anyone can claim **all** Invoice
  notifications are isolated.
- OTP cookie is synthetic; no actual hosted OTP email, HTTPS browser or
  mobile Owner session was used. No real financial writes were executed.
- The hosted Invoice roles remain NOLOGIN; current tax B6 policies and
  two audit-column INSERT GRANTs remain unapplied; the five-file original
  owner package is QA-staged only; active financial flags remain OFF.
- No `to_invoice` CST/Diva documents exist to authorize real issuance.

Keep Portal PR232 and paired QA PR Draft; no merge, deployment or PROD
changes until full hosted DEV release gates PASS.
