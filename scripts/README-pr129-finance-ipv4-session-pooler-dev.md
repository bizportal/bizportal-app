# CST-DEV Finance — exact verified IPv4 Session Pooler cutover

**Release state: Draft; NOT an authorization to change active Writer, credentials
or PROD.** Source code and company sessions have been independently tested
without payment, journal posting or external messaging.

## Verified cause and proof

- Existing ONE Supabase project: `xssrfshdrtdfupgqwfdw`, one DB `postgres`.
- Existing ONE Google Cloud project and ONE secret
  `bizportal-marketplace-finance-dev-companies` containing TWO independent
  restricted PostgreSQL company logins (CST ID 1 and Diva ID 3).
- Current secret DSNs have direct `db.xssrfshdrtdfupgqwfdw.supabase.co:5432`
  host. At VPS `srv1792369` it resolves only IPv6 and both company sessions
  return `ECONNREFUSED`. Neither role password nor RLS is the cause.
- The ALREADY EXISTING DEV administrator Session Pooler at port **5432**
  resolves IPv4 and connects from the same VPS. This is a SESSION pooler;
  do not silently switch to transaction-pooler port 6543.
- Direct positive test **without touching GCP versions**: in-memory use of
  the same two company passwords with `company_role.project-ref` usernames on
  that Session Pooler; `rootCertificates + SUPABASE_FINANCE_ROOT_2021_PEM`,
  verified pinned CA fingerprint, `rejectUnauthorized=true`, explicit
  `servername`. For BOTH CST and Diva, client TLS encrypted and authorized,
  `current_user=session_user` correct, `transaction_read_only=on`, RLS active,
  own-company PO visible, other-company PO zero. Both transactions ROLLBACK.
- Source change in this PR: same pinned 2021 public CA trust now explicitly
  included for the pooler. No `ssl:false`, no hostname skip, no shared
  `postgres` Finance fallback, no changes to `session_user` parent lock.
- Local 34/34 targeted tests PASS, API TypeScript PASS; GitHub CI [#44110387688]
  (https://github.com/bizportal/bizportal-app/actions/runs/44110387688) SUCCESS.

## Controlled cutover — proposed steps and gates

1. **No concurrent QA or deployment.** Confirm shared CST-DEV has no QA
   `QA-DEV-INVACCEPT-*` PO/invoice/AP/handoff residue, no
   idle-in-transaction company sessions, no new payments/GL/notifications.
   Record current private preview exact runtime SHA, deployment lock, flags,
   systemd/Nginx hashes and current rollback receipt. Do not touch public
   BizPortal DEV, Customer Portal, PROD or unrelated apps.
2. **Code readiness first.** Refresh the latest canonical invoice branch
   and ensure no commits are being overwritten. Build this CA change plus
   the exact current Invoice QA/cleanup and 48/64 token validation into an
   offline, inactive private Finance artifact. Verify SHA/checksum and
   rollback metadata. Test original signed HTTPS deny rules without enabling
   any action.
3. **Protect the ONE existing GCP secret.** Preserve the current secret
   version through existing owner-controlled custody; do not copy passwords
   into a chat, git, logs, or command arguments. Prepare a replacement JSON
   *in memory* whose schema still has only `version:1`, companies `1`
   and `3`, two distinct `role` identities and `databaseUrl`. Change
   ONLY DSN host to the existing verified IPv4 Session Pooler, port to
   **5432**, usernames to `role.xssrfshdrtdfupgqwfdw`; keep passwords,
   database `/postgres`, `sslmode=verify-full` and absolute
   `sslrootcert`. Pre-validate source and candidate role/endpoint/TLS,
   and never introduce privileged or shared credentials.
4. **Coordinated version and process restart.** An added Secret Manager
   version becomes `latest`; a live Finance pool must not silently switch
   while running. Advance the version only when the exact new artifact and
   service restart/rollback window are secured. Do not use the old deployer
   against a different already-active candidate: it intentionally refuses
   source drift. Carry forward current active source/rollback history or
   use a separately reviewed release procedure with a pinned current SHA.
5. **Read-only real E2E first**, after restart: CST/Diva distinct sessions,
   verified TLS and hostname, `session_user` role, RLS across all 11
   canonical Finance tables, other-company PO 0 and spoofed GUC denied.
6. Then run **one** bounded synthetic QA: authorized private vendor HTTPS
   PDF upload, 3-way match, AP `waiting_payment`, draft-only Accounting,
   replay/idempotency, no paid amounts or posted GL, notifications/WA/Gmail
   OFF. End each AP lifecycle step in its own Finance transaction, with
   short lock/idle timeouts and independent audit callbacks. Cleanup
   only exact run-owned synthetic parents/private PDFs after checking
   statuses, ownership, no payment/GL, zero queue, and PO14 unchanged.
7. Signed Super Admin browser session must be genuinely authenticated to
   count as live admin HTTP E2E; synthetic tests cannot substitute it.
8. **Failure/rollback:** Stop Writer/Handoff first; do not weaken RLS,
   disable TLS or reissue real vendor tokens. Restore the prior exact
   artifact/systemd/Nginx config. Re-publish the *previous secret payload*
   through approved custody as a new version if the pooler version was
   already advanced (disabling an added version does not guarantee `latest`
   selects the old one). Restart to clear credential caches and reverify
   health, company scope and zero side effects. Leave Writer OFF until
   ready to rerun positive tests.

**No PROD activation follows automatically from DEV QA.** Owner manually
verifies PROD only after explicitly approved promotion.
