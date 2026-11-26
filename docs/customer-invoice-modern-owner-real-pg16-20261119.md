# CST-DEV — existing Accounting engine + modern signed Owner Invoice E2E

**Status: source-only isolated PostgreSQL16 PASS. Hosted CST-DEV and PROD
still NO-GO.** Nothing changes the original Posting Engine or any active service.

## Exact source combination

- Original Accounting owner: official BizPortal Draft PR #142
  (test/dev-customer-invoice-atomic-ppn-20261118), base
  2c3392688c2fc4b8a7ffd18e2a93192591bff111.
- Modern Customer Portal: Draft PR #231,
  691a9c23afdd927fdb1012891a7704233f553d62.
- Separate-device BizPortal Owner signer: Draft PR #155,
  9ade41f0ab3459841a7e3b154202357f9000496d.
- GitHub workflow pins both external exact commits; no unreviewed branch
  movement, no old Travelintrips BizPortal mirror.

## Reused real components

The QA build uses the unchanged original CanonicalPostingEngine and its
five-file Pino bundle, with all five SHA-256 hashes checked against the
original Portal's immutable loader. It imports the actual current Portal
billing-operations, signed financial HMAC challenge, tax-source FOR SHARE
locks, one-time Owner handoff, and BizPortal Ed25519 signer.

Original source DB writes/SQL are used. Only network/IO boundaries are
substituted by a dedicated test-only bundle: simulated OTP session lookup,
role-specific direct PostgreSQL connection *to the disposable database*,
and outward notifications. No new journal/AR/tax writer is implemented.

## Disposable test environment and coverage

Run:
bash scripts/tests/customer-invoice-modern-role-pg16.qa.sh

The script runs the PR #142 preexisting original-owner test and then
adds a second isolated test fixture. All SQL files are protected by
current_database()='invoice_synthetic'. A brand-new disposable
postgres:16-alpine container is bound only to a random localhost port.
CST/Diva data, credentials, and issuer/Owner identity are synthetic.
QA writer PostgreSQL roles are LOGIN for this disposable instance ONLY,
NOSUPERUSER, NOINHERIT, NOBYPASSRLS, CURRENT_USER=SESSION_USER.
For test convenience, synthetic roles have broad temporary table GRANTs;
RLS remains active and company-scoped on the financial-sensitive tables.
**Do not interpret these synthetic GRANTs as verification of hosted
CST-DEV's real least-privilege grants.**

The preexisting PR #142 fixture first runs Diva's 12% PPN case.
Before the separate modern 11% case, *only the throwaway fixture*
restores its default sales tax from synthetic 12% ID 4 to 11% ID 3.
This is not a tax-rate recommendation or production change.

The original AR trigger's actor config in old PR #142 is scoped to
Finance readers. The separate temporary fixture additionally configures
direct self-read for synthetic Invoice writer actors so the original
SECURITY INVOKER AR trigger can project a journal to AR. A read-only
audit of hosted CST-DEV already found corresponding original B1 Invoice
role actor policies and SELECT grants; this specific fixture gap is
not evidence of a hosted-DEV missing policy.

Results demonstrated on disposable PostgreSQL16:
- Both company roles are direct, non-bypass and RLS-active; foreign
  company's invoice rows are invisible.
- Same-company accounting settings and original tax source FOR SHARE
  locks are permitted.
- Signed Owner review shows canonical customer, subtotal, output PPN and
  gross; HMAC SHA256 digest / Ed25519 proof matches original source.
- The BizPortal Owner review endpoint is reached through loopback HTTP
  and consent is submitted through the Portal handoff HTTP form route.
- The original new billing handler + original Posting Engine produce one
  balanced 3-line journal, one PPN transaction tax, original AR
  projection, one Accounting audit and one existing financial outbox,
  all from the same PostgreSQL transaction for both CST and Diva.
- A second separately signed review for each company reuses the same
  original journal and AR/tax/audit/outbox without duplicates.
- The simulated role=admin on the signer is refused (HTTP401).
- A valid signed proof for a different Invoice is rejected before
  issuance and leaves the original source to_invoice, no financial writes.
- The original PR #142 existing GL/PPN/AR/outbox replay/rollback/12%
  fixture suite runs in full before the modern fixture.

## Explicitly not proven by this test

- Real user OTP email issuance/delivery or real account cookie renewal
  on hosted BizPortal DEV.
- Live HTTPS web frontends/phones and network origin/COOP/CSP behavior.
- Actual hosted CST-DEV database credentials, real role activation,
  bounded release window, real staff Admin authorization, populated
  to_invoice business documents or full least-privilege policy parity.
- Deployment of the reviewed five-file owner bundle to the active
  Customer Portal container (currently absent), durable multi-replica
  handoff ticket storage or production cutover.
- Any posting to live CST-DEV/PROD, payment/banking/WA/Gmail dispatch.

**Release decision: NO-GO for operational DEV/PROD.** Both finance feature
flags remain OFF, the hosted writer roles remain NOLOGIN, and no
company role/financial history has been changed. Maintain Draft PRs.
