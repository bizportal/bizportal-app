# CST-DEV Invoice — original Owner bundle QA and minimum audit-column permissions

**State: source-only Draft; operational release remains NO-GO.**

## Current read-only evidence on CST-DEV (19 November 2026)

The original Invoice handler in Customer Portal PR #231 inserts into
`public.audit_accounting_events` using the actual original posted Accounting
entry, with columns `journal_id, action, company_id, amount, user_id,
actor_type, correlation_id, change_reason, after_state`.

Both active CST-DEV writer roles already have column-specific INSERT for
the first seven fields and USAGE on the existing audit sequence. They do
**not** have INSERT for the last two fields (`change_reason`, `after_state`).
This would reject the complete audit write and force the Invoice transaction
to roll back. The prior disposable PR #156 granted broad privileges to
*synthetic* roles and therefore could not expose this missing hosted grant.

The existing B1 RESTRICTIVE audit company rule and B4 journal-bound INSERT
rules remain in place. Both writer roles are NOLOGIN and NOBYPASSRLS.

## Narrow source-only proposal and rollback

- `scripts/dev-customer-invoice-audit-columns-20261119.sql`: grants
  **only INSERT(change_reason, after_state)** to the two existing Invoice
  roles. Preflight requires both remain NOLOGIN/NOBYPASSRLS and existing
  company/source B4 policies to be present. No role promotion, password,
  UPDATE, DELETE, table-wide grant or new audit implementation.
- `scripts/dev-customer-invoice-audit-columns-rollback-20261119.sql`:
  precisely revokes those two column grants after flags are OFF and active
  Invoice transactions are drained.
- Neither SQL was executed on hosted CST-DEV, and neither is for PROD.
  A future authorized migration must check the exact project ref first.

## Actual isolated PostgreSQL16 proof

`bash scripts/tests/customer-invoice-audit-columns-least-privilege.qa.sh`
creates a network-disconnected disposable PG16 container. It uses a small
synthetic facsimile of the real restrictive company policy and journal-bound
B4 insert policy. A direct-login non-bypass test role first fails to write
the complete audit with original column grants, then succeeds only after
the exact proposed two-column grant. Cross-company and forged journal
correlations still fail. Reverting the grants returns the initial denial.
All cases PASS; container is destroyed.

## Original Accounting immutable bundle QA

`scripts/tests/customer-invoice-reviewed-owner-qa-stage.sh` reproduces
the *unmodified* CanonicalPostingEngine release from official PR #142.
It verifies all five pinned SHA-256 digests, imports the module and
proves feature-OFF fail-closed. On VPS it stages **code only** into
`/opt/cst-invoice-dev-stage-20261119/qa-reviewed-original-owner-bundle`
with restricted permissions. It never writes into the actual loader path
`/opt/cst-customer-invoice-owner-bundle-dev`; no database credentials,
OTP secrets or user sessions are staged. An exact source manifest is
stored with the read-only QA artifacts. CI uses a separate temporary
`/tmp/cst-reviewed-owner-qa-*` destination and removes it afterward.

## Actual operational gates remaining

1. Owner's already-matched Portal Admin account and canonical BizPortal
   Super Admin account permit a future **Owner-issued** first DEV test for
   CST/Diva without appointing a new staff Admin. Delegation to another
   Admin still requires explicit company authorization.
2. There are currently zero real new `to_invoice` documents for CST/Diva;
   do not rewrite historical Invoice or manufacture financial activity.
3. Hosted Invoice writer roles remain NOLOGIN, the AR source actors are
   disabled, the B6 tax-lock policy is not applied and all financial flags
   on the active Portal are OFF.
4. PR #156 already proves modern signed-review-to-original Posting Engine
   GL/PPN/AR/audit/outbox COMMIT and replay on isolated PostgreSQL16, but
   **only with synthetic credentials/OTP**, not real hosted HTTPS OTP.
5. On the dedicated company writer, direct Portal customer/admin
   notifications are best-effort and read `portal_customers` and
   `portal_company_members`. These do not currently have general SELECT
   for Invoice writers. Do NOT silently grant unrestricted customer-data
   access; validate the existing financial outbox delivery separately as
   part of full hosted DEV acceptance.

Keep all PRs Draft and all actual financial flags OFF until the real
authenticated hosted DEV E2E, exact least-privilege checks, and rollback
evidence PASS. Never change PROD as part of this test.
