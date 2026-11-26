# DEV Invoice payment notifications: company-scoped original Portal inbox QA

**Source-only QA; no hosted CST-DEV or PROD data, identity, email or financial writes.**

## Exact source pins

- Customer Portal Draft PR #235:
  `b47b1e1fb559f0a51a8cdf3ac4df6a4a1e3ce63c`
- BizPortal signed Owner Draft PR #155:
  `9ade41f0ab3459841a7e3b154202357f9000496d`
- Original unchanged BizPortal PR #142 `CanonicalPostingEngine`
  (reviewed five-file SHA-pinned bundle).

## Why

The old `notifyAdmins` sent payment status information to all active
Portal Admins even when they lacked the invoice's company scope.
Customer Portal Draft PR #234 already confined NEW Invoice issuance to
the authorized issuer, but the customer payment-submitted and Admin
payment-status changes were still broadcast globally. Child PR #235
limits those existing calls to canonical active Owner accounts or
company-scoped active staff Admins with active Portal membership.

## Actual isolated PG16 verification

Run `bash scripts/tests/customer-invoice-modern-role-pg16.qa.sh` on
the disposable PostgreSQL16 fixture. This test loads 122 real
CST-DEV Invoice B1/B2/B3/B4 RLS policies from read-only metadata,
the current hosted column/sequence GRANT snapshot, and the
corrected B6 tax lock + audit source-only candidates.

The existing original Posting Engine and one signed synthetic Owner
approval commit original GL, PPN, AR, audit, financial outbox and
issuer-only Invoice notification for CST and Diva, with replay and
invalid proof rollback PASS.

Additional tests use the REAL Portal notification service (no mock),
called with a synthetic Portal service DB transaction, to simulate
`sales_payment_submitted` and `sales_payment_status_changed` internal
inbox events. On each company, duplicate event delivery is attempted
twice to ensure the existing unique (recipient,event_key) constraint.

Expected actual persisted recipient IDs:
- Company1/CST: global canonical Owner Portal Admin #501 only
- Company3/Diva: global canonical Owner #501 and company-scoped Admin #503
- Unassigned active Portal Admin #504: **no receipt for either**

The test asserts exact receipt rows and no unrelated recipient,
alongside the full original accounting issuance and replay proof.

### Boundaries

This tests notification recipient resolution and internal event
persistence. It does **not** execute real bank settlement, the entire
`handleCustomerPayments`/`handleAdminPayments` HTTP write path,
outbound email/WhatsApp or actual hosted Portal service permissions.
All recipient and payment IDs are synthetic. The scoped lookup may
fail closed (no broadcast), but explicit alerting on such failures
should be verified before operational financial release.

All active CST-DEV financial flags stay OFF, writer roles NOLOGIN;
real B6/audit changes not applied, no invoice-ready documents added.
All affected PRs remain Draft; PROD unchanged.
