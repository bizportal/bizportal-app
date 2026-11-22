# BizPortal Payroll DEV — dedicated approver credential (staged only)

This is an **opt-in source-only capability**, not authorization to
activate approvals, payments, accounting, or production deployment.

## Existing safeguards retained

- Only `APP_ENV=development` may read a Payroll approver secret.
- Both `PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED=true` and
  `PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED=true` must be intentionally
  selected before credential preparation runs.
- The route still requires a signed OTP Super Admin session, server-side
  company scope and real PostgreSQL authorization checks.
- A dedicated role `bizportal_payroll_approver_dev` must be used.
  The original `bizportal_payroll_dev` and service-wide credentials are
  never substituted or used as a fallback.
- No approvals, salary payments, GL posting, or kasbon settlement are performed
  by this credential initializer.

## Configuration contract

The optional environment variable
`PAYROLL_APPROVAL_GCP_SECRET_NAME_DEV` must identify a **separate DEV
secret** with a name matching `bizportal-payroll-approver-dev` or a
narrow suffix under that name. The value should be a dedicated PostgreSQL
URL for CST-DEV only, using exact dedicated username, database `postgres`,
and verified TLS (`sslmode=verify-full`). Query parameters are limited to
`sslmode` and optional `sslrootcert`; duplicate/override parameters are
rejected. No secret contents are printed in logs or committed to source.

Only the existing GCP Secret Manager service-account bootstrap may fetch
the value. Do not place keys in GitHub, pull-request comments, a frontend,
browser localStorage, or an application-wide generic database secret.

The direct `PAYROLL_APPROVAL_DATABASE_URL_DEV` path remains for old
isolated tests but it **cannot** coexist with the managed-secret selector.
The resolver fails closed if either source is ambiguous or the managed secret
is absent or invalid. Rotation to a different secret value requires a
controlled restart.

## Live CST-DEV prerequisites — NOT YET PASS

1. The dedicated `bizportal_payroll_approver_dev` database role presently
   exists only as `NOLOGIN`; secret and account provisioning must be
   authorized via trusted custody, not silently invented.
2. Review the six existing tenant-scoped RLS policies and verify exact table
   privileges. No INSERT into payroll items, no salary disbursement, no
   Accounting GL or payment-column UPDATE.
3. The legacy `bizportal_payroll_dev` role no longer has
   `UPDATE(approved_at)`; historical HR review `draft→reviewed` using
   status and notes was tested with rollback. Preserve this behavior.
4. Validate a real signed OTP Super Admin login and company selection in
   a separate isolated DEV runtime, not through a simulated test cookie.
5. Use disposable DEV fixtures with a rollback check for approval digest,
   stale data, tenant isolation, duplicate click, and historical Payroll.
6. Require a full API regression, typecheck, build, real application health,
   and a reversible deployment plan before any release.

Do not deploy Payroll to PROD until roster reconciliation, verified salary
components, end-to-end Payroll/Accounting isolation, and final owner
acceptance gates are independently passed.

## CI / release-source selection

This review branch includes the signed-session DEV-only mount code from PR #110
so its cumulative test gates can run against official `main`. Neither draft PR
is authorized for automatic merge or deployment; compare exact commit SHAs
and retain the current production runtime unchanged.


## Reuse existing GCP DEV systemd credentials (PR #81)

This candidate reuses the tested existing PR #81 \`LoadCredential\` reader. It
only opens the fixed credential filename \`gcp-secret-manager-bootstrap.json\`
from systemd's \`CREDENTIALS_DIRECTORY\` when both
\`APP_ENV=development\` and
\`BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED=true\`.
The regular environment credential remains supported and takes precedence.
The file is bounded to 1–32768 bytes and invalid credentials fail closed.
The systemd fallback is disabled in PROD. The same six synthetic-only tests
were ported without any real key or live GCP network calls.

The existing GCP DEV infrastructure can therefore be reused; no new GCP
project, bootstrap key, login system or secret-store implementation is needed.
A *dedicated* Payroll approver secret entry and PostgreSQL LOGIN are still
separate authorization requirements and have not been verified or activated.
