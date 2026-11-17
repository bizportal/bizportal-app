# DEV Finance: One unchanged GCP secret, one CST-DEV Supabase, verified IPv4 pooler bridge

**Status:** Draft candidate only. No new credentials, secret versions, GCP projects,
database, database roles, password rotation or PROD changes.

## Confirmed failure and positive proof

- The existing single Finance Secret Manager payload contains two different
  limited LOGIN credentials: company 1 CST and company 3 Diva Servis, each
  pointing at the **same** CST-DEV Supabase project
  `xssrfshdrtdfupgqwfdw` with a direct
  `db.xssrfshdrtdfupgqwfdw.supabase.co:5432` endpoint.
- From DEV VPS `srv1792369`, that endpoint has only IPv6 DNS results,
  and the TCP connection returns `ECONNREFUSED`.
- The existing authenticated DEV administration Session Pooler connects over
  IPv4 at `aws-1-ap-southeast-2.pooler.supabase.com:5432`. It is a
  **session** pooler, not transaction pooler 6543; a distinct transaction
  must retain one authenticated PostgreSQL identity through its complete
  lifecycle. Its TLS chain validates using system roots and the existing
  audited public Supabase 2021 root with pinned SHA-256 and explicit hostname.
- A direct *read-only* actual CST-DEV QA on the new source has independently
  confirmed BOTH real company roles, verified TLS, 11 role-specific RLS
  guards, session_user/current_user identity, scope, spoofed GUC denial,
  own-company reads, foreign-company PO = 0, GL/payment writer denial and
  complete ROLLBACK. No passwords or DSNs printed or stored.

## Narrow opt-in (OFF by default)

Set `BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV=true`
**only** on the isolated private DEV Finance Writer process with existing:
`APP_ENV=development`,
`BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV=true`, and
`BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV=true`.

The original two URLs remain unchanged in **one** existing Secret Manager
version. The new server code refuses the bridge unless the verified source
hostname is exactly the project direct DB, port is 5432, database is
`postgres`, source username is exactly the expected restricted company role,
and existing `sslmode=verify-full`/absolute CA requirements pass. Then and
only then the **driver's in-memory target** uses the immutable, reviewed
Session Pooler host, username `company_role.xssrfshdrtdfupgqwfdw`,
port 5432, with the unchanged password, trust-root certificate and
`ssl.rejectUnauthorized=true`/matching SNI. No caller-supplied host or
project string; no shared postgres/generic Finance account. Wrong host,
wrong mode, PROD, privileged roles and malformed certificates fail closed.

Connection pools remain max one per company and cached credentials never
switch identity. Runtime mode change requires restart; no dynamic toggle.
Rollback is simply to the previously recorded inactive source and previously
recorded systemd/Nginx configuration; **no GCP secret version rollback**
is required. Preserve Writer/Handoff and outbound messaging flags as
independently configured, and do not start QA until the exact active code,
private Storage and signed HTTP gates are reverified.

## Release gates not yet claimed

1. Separate, audited **private** DEV-only cutover from exact active SHA
   `7aaf715e8910618ff181b13774a778402f38e417` to a newly built exact
   source candidate, with recorded rollback state and a deployment lock.
   The old deployer deliberately refuses to replace an already active newer
   candidate; **do not strip its hardcoded drift guard**.
2. Actual authenticated HTTPS vendor PDF upload → 3-way match → AP
   `waiting_payment` → Accounting `draft_not_posted` using the unchanged
   canonical services, only synthetic company-bound fixtures.
3. Test replay/idempotency and end-of-run deletion of ONLY exact synthetic
   parents/private objects after proving zero paid amounts, zero posted GL,
   zero outbound notifications and PO14 unchanged. Retain historical audit.
4. Real signed owner/Super Admin HTTP session is a separate gate from
   backend synthetic acceptance, not something to manufacture with admin DB.
5. Leave PROD, operational Fleet/WA and the public Customer Portal unchanged.

**Security choice:** This is deliberate DEV-only routing of an already
validated private company's credential. If the pinned region/pooler changes,
fail closed and independently reverify the target, don't silently fall back
to IPv6 or turn off TLS.
