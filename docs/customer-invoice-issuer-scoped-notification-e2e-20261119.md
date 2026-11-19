# Customer Invoice: signed Owner issuance notification recipient isolation

**New source-only QA; no hosted CST-DEV or PROD changes.**

## Exact pinned references

- Customer Portal Draft PR #234, SHA
  `812f6d384c610f027f125e6d859644c6e0eae705`.
- BizPortal signed Owner PR #155, SHA
  `9ade41f0ab3459841a7e3b154202357f9000496d`.
- Original BizPortal `CanonicalPostingEngine` from PR #142; original
  five-file ESM SHA256 pins unchanged.

## Why this is necessary

`notifyAdmins` originally picked every active `portal_customers.role=admin`
without company scope. A read-only hosted CST-DEV aggregate check
confirmed two active Portal Admin identities with no active explicit
company membership for CST or Diva. Only one matches the global
canonical Owner. Existing B4 RLS permits an active Admin recipient
without enforcing a canonical BizPortal company membership; therefore
the old Invoice issuance event could reach an unassigned Portal Admin.

Current Portal source passes only the already-authorized Portal
`mark_invoiced` issuer ID to the existing notification service.
Legacy generic notification service stays unchanged unless explicit
`explicitAdminIds` are passed. Existing marketplace and payment
status notification pathways retain their prior behavior, and payment
recipient scope is an independent release review gate.

## Real source PostgreSQL16 QA

The QA bundler now imports **real**
`server/notification-service.mjs` rather than a stub. Test assertions
read actual `portal_customer_notifications` rows committed with the
original Owner-authorized Invoice and Accounting journal. It uses the
prior exactly cloned 122 CST-DEV Invoice writer RLS policies, 22-table
column grants, B6 corrected tax locking and two audit-column grants
on the disposable database only.

Fixture: synthetic Owner Portal Admin #501 issues CST and Diva Invoices;
synthetic Admin #503 has membership in Diva only; synthetic #504 is
an unassigned active Portal Admin. All are fake local records.

- Original GST/PPN GL/AR/audit/outbox still PASS with same transaction.
- Issuing Admin #501 receives the Invoice event.
- Unassigned Admin #504 receives neither company's event.
- Diva-only Admin #503 does not receive CST Invoice.
- Replay remains idempotent; original B1/B2/B3/B4 RLS and rollback
  negative tests still pass.
- The original `financial_outbox_events` remains the durable
  Accounting event source, not replaced by this Portal inbox message.

## Release boundary

Only isolated, simulated OTP-session HTTP QA. Actual hosted email OTP,
HTTPS device session, registered company invoice-ready source and
approved live DEV transaction are still untested; financial flags
remain OFF and both Invoice writer roles NOLOGIN.
No schema/grants changed on hosted Supabase or PROD.
