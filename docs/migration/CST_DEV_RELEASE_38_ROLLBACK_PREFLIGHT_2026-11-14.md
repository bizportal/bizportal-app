# CST BizPortal DEV — PR #38 release and rollback preflight (14 Nov 2026)

> **NO-GO for cutover.** Read-only evidence only; do not merge stacked PRs repeatedly or modify PROD. The script `scripts/dev-canonical-cutover-readiness-readonly.sh` checks invariants without changing any runtime state.

## Source pins and service identity

| Item | Checked value |
| --- | --- |
| Live DEV code | `Travelintrips/CST-BIZPORTAL` `2705d4c720fb7aa5d34f72ba60ef55be4dd91d7d` |
| Live DEV working directory | `/opt/cst-bizportal-gmail-dev` |
| Live frontend Nginx root | `/opt/cst-bizportal-gmail-dev/dist/public` |
| Live API upstream | `127.0.0.1:19784` |
| Live systemd unit | `cst-bizportal-gmail-dev.service` |
| Isolated canonical PR #38 SHA | `4d424e5ffa77285dcf7a6414f129bcc0ed195289` |
| Isolated PR #38 checkout | `/opt/bizportal-pr38-shadow-check-20261114` |
| SHA-256 of inspected Nginx site file | `c9c8e9c72d02987ace325a072504b9087be7219e3b9c0a6df6a6af403d25553c` |

Both checked worktrees were clean; `nginx -t` succeeded; unauthenticated local `/api/auth/user` and `/api/companies` returned 401. These prove some baseline invariants, **not** that a valid authenticated session works.

## Independent scoped regression

On the isolated PR #38 checkout, `pnpm install --frozen-lockfile --prefer-offline` succeeded. Seven focused test files **93/93 PASS**, including Purchase role matrix, Gmail review atomic mock, QRIS MDR, bank-posting and source-integrity tests. GitHub Release Gate run #43601300555 was previously verified SUCCESS on exact PR head.

No real payment, QRIS settlement, posting, Gmail candidate review, or outgoing mail was executed.

## Database-role and RLS findings from CST-DEV

Verified using connected Supabase **CST-DEV** project `xssrfshdrtdfupgqwfdw`, querying only system catalogs / ACLs / policies, not business rows:

- `users`, `companies`, `gmail_invoice_candidates`, `bank_mutations`, `vendor_invoices`, `payment_allocations`, `payment_matching_groups`, `app_config`, `bizportal_email_otp_codes` and `accounting_entries` have row-level security enabled.
- Database role `bizportal_dev_runtime` has selective read access but not direct Gmail/Bank/OTP access.
- `aicore_dev_runtime` has broad SELECT/INSERT/UPDATE grants and is explicitly permitted by policies on Gmail/OTP candidates, so *application-side user/company authorization is critical*.
- Public `anon` and `authenticated` roles may have table grants on selected `users` or accounting relations, but RLS policies must be evaluated; grants **do not establish readable row exposure**.
- **Critical:** In the active BizPortal process, the configured `SUPABASE_DATABASE_URL_DEV` is a pooler URL with a `postgres.<project-ref>` username pointing to the verified CST-DEV project; it is **not** the restricted `bizportal_dev_runtime` role. This is a privileged DB connection and cannot be treated as proof of RLS tenant isolation. Credential bytes, host URL/password and cookies were not collected in evidence.
- Switching DB credentials would likely affect old queries; **do not silently rotate**. First test a dedicated restricted role with a read-only shadow session and role/tenant-specific requests, and verify all required grants under explicit approval.

## Rollback choreography (plan only — not executed)

1. Before any future cutover, record original remote, active SHA, Nginx file SHA, service unit paths and **a verified backup of deployment configuration** through approved secret-safe channels. Never copy secrets into Git or CI logs.
2. Build and validate the canonical SHA in a distinct directory, without reusing the Nginx-served root, API port or scheduler.
3. Rehearse an **isolated** rollback of source selection and re-run static/API/auth checks. This cannot be replaced by `nginx -t` or test CI alone.
4. Only after written authorization and full parity, separately change DEV deployment pointer; keep the previous immutable working directory and artefacts.
5. If HTTP/auth, company scope, QRIS, OCR, PDFs, payroll, or finance checks fail, stop and use the pre-recorded original deployment pointer/HA restart procedure; monitor for side effects.
6. PROD and background Gmail/WA/QRIS jobs are outside this rehearsal and must not be touched.

## Hard blockers / go-no-go

- Authenticated OTP Login -> actor -> company scoping on the **actual isolated DEV environment**, using credentials dedicated to CST-DEV and no PROD mailbox.
- Validate DB session role and tenant isolation with real permitted role, including denied cross-company requests. Never infer RLS enforcement from server-side row visibility.
- Real read-only and non-posting Accounting/QRIS/Bank, Purchase Workflow role parity and runtime UI behavior.
- Print an A4 PDF through an authorized browser session; confirm CST company letterhead without issuing a real transaction.
- Isolated rollback rehearsal and verification of its actual success, complete CI on a single candidate SHA, and GitHub branch protection/status-check requirements.
- Do not set OTP, Gmail review, Customer AR or template flags in live DEV before the controls above pass.

## Script usage

Run `bash scripts/dev-canonical-cutover-readiness-readonly.sh` **only on the authorized DEV VPS** (with optional explicit path overrides). This command has no write, restart, reload, merge, checkout, dispatch, file copy, or access-token output. A PASS means the previous deployment is still intact, **not that the candidate is ready to deploy**.
