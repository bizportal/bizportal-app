# CST Customer Portal DEV — actual Admin payment endpoint under company authority

**Source-only / disposable PostgreSQL16, not a hosted financial release.**

## Pinning

- Customer Portal Draft PR #236 source
  `54e5813207d05c34260a9643813c870bf78f9674`.
- Signed Owner BizPortal Draft PR #155 source
  `9ade41f0ab3459841a7e3b154202357f9000496d`.
- Original unchanged PR #142 CanonicalPostingEngine, five immutable SHA pins.

## Previous defect / correction

The original `GET /api/portal/admin/payments` and
`POST /api/portal/admin/payments/:id/status` checked Portal Admin
authentication, but did not authorize **which company** the Admin
could see or mutate. In particular, a payment with its status already
`paid` could be replayed with HTTP200 before the Admin's company scope
was checked. The existing PR #235 notification recipient filter
did not protect payment database mutation.

Current Portal PR236 derives company scope from active and uniquely
matched `public.portal_customers` and canonical `public.users`,
checking the authenticated Portal ID/email and current roles under
the same transaction with FOR SHARE row locks. Global/company
`super_admin` may act within their scope. Ordinary Admins require
company-specific active BizPortal role **and** active Portal
`portal_company_members`, also row-locked. No Owner OTP is added
to ordinary company Admin payment-status work.

GET is filtered by matching Invoice and payment company; POST
checks the payment's company, Invoice's company and `invoiced` state
BEFORE replay or any UPDATE. Existing transition rules and the
original payment/AR accounting triggers remain untouched.

## Test setup

The prior official original owner PG16 QA script loads an additional
`scripts/tests/customer-invoice-admin-payment-status-disposable.sql`,
guarded to the ephemeral `invoice_synthetic` database. It adds only
synthetic payment enum/table/source rows modeled on the real read-only
CST-DEV `public.payments` column definition. No bank API, real payment
record, user token, account, external email or WA is involved.

Exact source `handleAdminPayments` is called from the same bundled
Customer Portal module as the original Invoice handler. All original
122 CST-DEV Invoice writer RLS policies and 22-table/nine-sequence
GRANT metadata are loaded on the disposable database. The original
reviewed AR trigger is enabled on this synthetic database.

## Actual PostgreSQL16 results

- The original signed Owner Invoice issuance via unchanged
  CanonicalPostingEngine produces the original GL, PPN, AR, audit
  and financial outbox for CST and Diva.
- A synthetic pending payment of **Rp40** on an issued synthetic
  Rp111 Invoice can be confirmed by an authorized owner or
  company-scoped Diva Admin (without another Owner OTP).
- After COMMIT: original Sales Invoice status `partial`,
  `amount_paid=40`, original `ar_subledger.paid_amount=40`,
  `outstanding_amount=71`, unchanged original journal, with
  company-scoped internal notification.
- Authorized repeated `paid` is idempotent; status `paid→failed`
  refused. Foreign-company and unassigned Admins cannot change or
  replay that payment, nor see another company's payment list.
- Payment.company_id inconsistent with Invoice.company_id or
  Invoice still `to_invoice` is refused without posting.
- All disposable table rows, temporary writer roles and containers
  are cleaned after test; original five Accounting bundle hashes unchanged.

## Limitations / operational release

This tests real payment-status source SQL on a throwaway DB but is
**not a live bank settlement, external provider callback, cash-journal
posting, production payment reconciliation, genuine OTP email or
HTTPS browser session**. The test uses a synthetic Portal-service
connection and no hosted SUPABASE_DATABASE_URL. Hosted CST-DEV's
real credentials, writer LOGIN, AR actor activation and real `to_invoice`
business documents are not available/enabled. Original Finance
Bank/Accounting posting must not be inferred from this handler alone.

Keep Draft/NO-GO. Do not merge/deploy or modify PROD/payment history.
