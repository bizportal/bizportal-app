# Existing Finance preview deployment

This procedure uses the existing private DEV service and the official BizPortal
source. It changes no database roles, GCP secrets, main DEV routes, PROD, payment
execution or WhatsApp configuration. It preserves the current signed-password
session and GCP bootstrap rather than generating authentication cookies.

## Observed baseline, 17 November 2026

- Service: `cst-bizportal-pr81-preview.service`, user `bizpr81preview`, loopback
  `127.0.0.1:19881`.
- HTTPS: `https://finance-pr81.72.61.210.205.sslip.io`.
- Active artifact: `/opt/cst-bizportal-pr81-e177-finance-ui-readonly-stage-20261116`.
- `source-commit.txt`: `e17749adba7faf975b9415dea8e3061dafe9af0a`.
- Bundle SHA-256:
  `cb7bc1a0a324ed1ce150eb2134937e1c47440f13110cb5077fc4bb62598f8b05`.
- The base unit plus `99-finance-ui-e177.conf` selects this artifact. The old base
  directory is the `a3f9061` Finance GET-only artifact; do not delete either one.
- GCP bootstrap: systemd `LoadCredential` from
  `/etc/bizportal-finance-dev/secret-reader.json` into
  `/run/credentials/cst-bizportal-pr81-preview.service/gcp-secret-manager-bootstrap.json`.
  Only names, mode and size were inspected; no credential value was emitted.
- `auth-preview.env` and the existing SMTP envfile remain in the current service.
  Signed password is enabled and signed OTP disabled. Preserve that mode and the
  session secret to keep the existing user's browser session usable.
- Local and HTTPS readiness returned 200; an unauthenticated `/api/auth/user`
  request returned 401. This does not establish any browser session state.

## Gates before Writer activation

1. Reviewed company RLS and parent-lock migrations are installed and reversible.
   The original abort-guarded proposal files remain intact.
2. The existing one GCP secret contains valid, distinct CST/Diva login URLs for
   CST-DEV. Direct authenticated TLS checks prove each company's RLS, including
   denial for a forged company setting. Admin/BYPASSRLS login is not that proof.
3. The signed company-selection route can durably audit through an authorized
   narrow session. The live database already has
   `pr81_finance_company_selection_audit_insert` for the restricted OTP login,
   scoped to the existing approved actor, action and company IDs. Preserve it;
   verify the matching column/sequence grants and positive signed request.
   Current source uses this `INSERT audit_logs` path when Writer is enabled.
4. Private Storage credentials for the same DEV project are securely configured.
   The current initial process environment has no Storage URL/key names; runtime
   dynamic secret loading was not proven. Upload code uses `private-uploads` and
   requires an actual stored/readable object. No synthetic upload bypass counts.
5. Existing notification callbacks are known to remain local when Writer commits;
   no external message or payment is emitted. The application review must prove
   this; the deploy script keeps existing messaging/scheduler flags false.
6. Build a self-contained artifact at
   `/opt/bizportal-invoice-completion-20261117`, containing `dist/index.mjs`, the
   frontend at `dist/public`, dependencies, `source-commit.txt` and a complete
   `RELEASE_SHA256SUMS.txt`. Pin the full source SHA when invoking the deployer.

## Storage envfile contract

Before the `writer` mode, prepare the existing-service-specific root-owned 0600
file `/etc/bizportal-finance-dev/vendor-storage-dev.env` through the controlled
credential path. It may contain exactly these two unquoted, single-line keys:

```text
SUPABASE_URL_DEV=https://xssrfshdrtdfupgqwfdw.supabase.co
SUPABASE_SERVICE_ROLE_KEY_DEV=<credential from authorized DEV custody>
```

The script validates the file in memory, never prints its contents, never copies
it into rollback state, and does not create or obtain the credential itself.
Do not insert it into Git, chat, a command argument, or an artifact manifest.

## Commands

On `srv1792369`, build the final integrated commit from an existing official
Git checkout. The verified host has Node 22.23.3, pnpm 10.33.0 and Python 3.12.3:

```bash
python3 scripts/build-invoice-finance-preview-dev.py --source /opt/INTEGRATED_OFFICIAL_CHECKOUT --expected-commit FULL_SOURCE_SHA
```

The builder exports that exact commit with `git archive` into a disposable
directory, installs the unchanged frozen lockfile from the pnpm store, runs the
existing API and Vite builds, and uses `scripts/prepare-hostinger.mjs` to combine
the outputs. `pnpm deploy --legacy --prod` supplies self-contained API production
dependencies. pnpm 10.33 leaves a self-package link to its build checkout; the
builder verifies that exact `@workspace/api-server` link and rebases it to the
artifact root. Any other escaping dependency link still fails validation.
It verifies the Node syntax, native/runtime dependency loading,
and that every symlink stays inside the artifact. Only then does it atomically
publish `/opt/bizportal-invoice-completion-20261117`; an existing target is always
refused. No service is started or reconfigured by this command.

If the existing store lacks a locked dependency, retry with `--allow-registry`.
That permits the normal registry fetch while retaining the exact lockfile,
existing minimum-release-age policy and approved install-script allowlist.
It does not upgrade dependencies. A failed build leaves no final target.

Build subprocesses inherit a small operating-system environment allowlist and
never read runtime envfiles. The Finance selector compiles enabled, the readonly
UI switch compiles disabled, and public Supabase/maps values compile empty for
the existing same-origin signed-password flow. Manifests include all regular
artifact files, internal symlinks, source commit, lock hash and tool versions.
The candidate must still pass the integrated application regression gates;
packaging is not a replacement for those tests or signed HTTP acceptance.

Render the exact non-secret drop-in and allowlist first, without server writes:

```bash
python3 scripts/deploy-invoice-finance-preview-dev.py render --mode writer
```

After the artifact and gates are verified, first install its source with Writer
off, preserving existing reader behavior and the private Nginx allowlist:

```bash
python3 scripts/deploy-invoice-finance-preview-dev.py apply --mode stage --expected-commit FULL_SOURCE_SHA
```

Then activate the same certified artifact for the authorized DEV business test:

```bash
python3 scripts/deploy-invoice-finance-preview-dev.py apply --mode writer --expected-commit FULL_SOURCE_SHA
```

Each application uses the pre-existing rollout lock. It stores only the prior
non-secret private Nginx configuration/drop-in and a metadata receipt under
`/var/lib/bizportal-invoice-preview-rollbacks`. It validates the exact current
baseline, atomically installs a separate `zz-invoice-completion-dev.conf`, tests
Nginx, restarts only the private preview and checks local/HTTPS readiness plus
unauthenticated denial. Failure restores the previous state automatically.
The generic `/api/` denial and all existing login routes remain in place.
The existing shared Nginx rate limit remains 10 requests/minute. Smoke checks
retry only HTTP 429, at most three attempts, with a 6.2-second minimum delay and
`Retry-After` bounded to 30 seconds. Other HTTP/transport failures are not retried.

The Writer drop-in clears the inherited generic Finance DSN/secret-name settings:
company mode deliberately rejects those values. It selects the existing one-GCP
secret mode and enables only Vendor Invoice/AP/draft Accounting plus private DEV
Storage. Writer mode also enables the existing session-bound vendor parent-lock
path. Both modes set `BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true`, so
the reviewed Finance post-commit suppression applies throughout the DEV test.
It does not enable settlement, bank approvals, GL posting, Gmail, or WA.
Writer mode also enables the company-scoped read-only Customer AR preview after
its bank-read RLS migration is verified. Stage mode leaves that feature off.

If the signed business test fails, use the printed rollback state:

```bash
python3 scripts/deploy-invoice-finance-preview-dev.py rollback --state-dir /var/lib/bizportal-invoice-preview-rollbacks/EXACT_PRINTED_STATE
```

Rollback refuses to overwrite a private drop-in or Nginx file modified by another
deployment. Rolling Writer back restores the stage-only candidate. Rolling that
stage back restores the original e177 preview. Business data is not deleted by
runtime rollback; use separately reviewed test cleanup/transaction rollback.

## Signed HTTP proof using the existing user session

Use the already authenticated browser tab on the **same preview origin**, and
the application's existing server-verified company selector. Inspect the UI or
authenticated `/api/auth/user` response without exposing cookies or token values.
Do not synthesize a signed cookie from the server secret or borrow a different
application's session. If the session expired, use the existing login flow.
The current legitimate flow is `POST /api/auth/email-login` using the owner-held
password for the configured pinned Super Admin account. The server checks the
stored bcrypt password, pinned ID/email, active status, `super_admin` role and
global account scope before issuing its signed cookie. OTP is disabled. If no
accessible authenticated tab or owner password login is available, record the
positive signed HTTP step as pending; database/service tests cannot establish it.

For one new DEV fixture, upload the PDF through the existing vendor token flow,
read it back from private Storage, match invoice, prepare AP, review Finance,
mark waiting-payment, and create draft Accounting. Repeat each action, compare
stable IDs/counts, and check another company cannot read or transition the rows.
Keep an explicit record of expected test rows and cleanup; verify no GL/payment
or external notification was emitted. A 200 health endpoint, a synthetic unit
session, or an anonymous 401 is not the positive end-to-end proof.

## Allowlisted additional paths

| Path | Methods |
|---|---|
| `/api/sales/customer-invoices/auto-match-preview` | GET only, exact location; company scope enforced by application and DB |
| `/api/mkt/admin/vendor-invoices/:id/match` | POST |
| `/api/mkt/admin/vendor-invoices/:id/ap-preparation` | POST |
| `/api/mkt/admin/ap-preparations/:id/finance-review` | POST |
| `/api/mkt/admin/ap-preparations/:id/waiting-payment` | POST |
| `/api/mkt/admin/ap-preparations/:id/accounting-handoff` | POST |
| `/api/mkt/vendor-invoice/:token` | POST multipart, Nginx limit 21 MiB for app's 20 MiB file limit |
| `/api/mkt/vendor-invoice/:token/invoices` | GET |
| `/api/mkt/vendor-invoice/:token/invoices/:id` | GET |
| `/api/mkt/vendor-invoice/:token/invoices/:id/submit` | POST |

IDs are 1–10 decimal digits without a leading zero. Tokens are exactly 64 hex
characters, matching the existing token service; token paths disable Nginx
access logging and retain no-store/no-referrer response headers. The app still
authenticates and authorizes every operation. Customer scope is AR preview and
matching for already issued canonical invoices. No customer issuance, POD, GL,
payment, or legacy owner route is added. Deployment checks require anonymous
Customer AR access to return 401 in Writer mode and 404 in stage mode; the legacy
sales action path remains 404.

## Offline validation of the deployment tool

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_invoice_preview_deploy.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_invoice_preview_build.py' -v
```

Eleven checks cover rejected payment/unrecognized paths, preserved authentication,
stale Nginx baseline refusal, artifact manifest path traversal, concurrent-change
rollback refusal, restoration after an injected Nginx validation failure and the
exact Customer AR route/anonymous denial in each mode, plus bounded 429-only
retries without retrying a failed connection or accepting anonymous access.
These checks never invoke a real service or replace the signed DEV business test.
Seven additional build-tool checks cover secret/environment isolation, portable
symlinks, narrow pnpm self-link rebasing, complete checksum generation and atomic
no-overwrite publication.
