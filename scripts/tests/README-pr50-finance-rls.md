# PR #50 — CST-DEV Finance RLS behavioral tests

These are **transactional database rehearsals**, not migrations or new Finance
implementations. They exercise the already installed dedicated Finance role
and the original canonical Marketplace tables.

## Preflight and use

Run **only against CST-DEV** (`xssrfshdrtdfupgqwfdw`) using the project's
authorized SQL session. Submit each **complete** script as one SQL request.
Do not run individual statements or run these scripts in PROD.

The scripts use synthetic foreign-key fixtures linked to existing company 1
and supplier 9. They require 18 dedicated Finance policies, an existing
non-BYPASSRLS Finance role, and unused fixture IDs (`990015001` and
`990015002`). A SQL guard checks these conditions and fails closed.

- `20261115_pr50_finance_rls_behavioral_rehearsal.sql`:
  complete synthetic PO/delivery/receipt, true Finance-role Vendor Invoice
  and line INSERT, company-1 visibility, cross-company read and write denial,
  and direct `ready_for_ap` INSERT denial.
- `20261115_pr50_finance_ap_rls_rehearsal.sql`:
  synthetic matched vendor invoice and Finance-role AP insert, review and
  waiting-payment transitions, draft Payment Request, draft-only Accounting
  handoff, cross-company reads denied, and attempted paid request denied.
- `20261115_pr50_finance_two_tenant_rls_rehearsal.sql`:
  creates two independent synthetic Marketplace PO/shipment/receipt/invoice
  chains in one rolled-back transaction: company 1 (supplier 9) and company 3
  (supplier 35). Checks positive reads for each tenant and negative reads for
  the other tenant in both directions. No fixture is retained.

Both use `BEGIN` and finish with `ROLLBACK`. Fixture primary keys are
explicit to avoid sequence changes, and none of the tested tables have enabled
user-defined business triggers. No uploaded files, emails, external messages,
payments or General Ledger entries are created. Assertions raise PostgreSQL
errors rather than silently returning a misleading result.

**Post-run checks:** no fixture IDs remain in RFQ/PO/invoice/AP/payment/handoff,
Finance policy count remains 18, role membership `postgres -> Finance role`
with SET remains disabled, and original business counts are unchanged.

## What the tests do *not* establish

- Direct TLS login with the dedicated role's own secret (not provisioned yet).
- A real Super Admin signed OTP, trusted company scope from the authenticated
  request, or full HTTP/Drizzle service E2E.
- Durability of a real draft AP and accounting handoff after commit.
- Cross-company **positive** visibility for company 3, which has no valid
  Marketplace finance records in the current CST-DEV dataset.

Never treat these SQL rehearsals alone as cutover approval.
