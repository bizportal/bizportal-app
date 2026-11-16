# PR #81 — DEV Preview GCP Bootstrap via systemd Credentials

This is an **optional, explicitly gated** way for an authorized administrator to
provision the **existing GCP Secret Manager bootstrap** to the *isolated*
BizPortal PR #81 preview. It does not implement a new login, database reader,
Finance writer, or credential store. The existing `readSecret()` implementation
still resolves the DEV database and optional SMTP configuration from approved
GCP Secret Manager entries.

## Current baseline

- Draft PR #81 source: `6b67b3fcfbeb383b9e4a77b9320e091ed6394f88`.
- Existing live BizPortal DEV, Nginx and PROD must remain unchanged.
- Preview `cst-bizportal-pr81-preview.service` runs as nonprivileged
  `bizpr81preview`, with all Finance/OTP/Accounting writer flags OFF.
- Current preview `/api/health/live` is 200, database and SMTP readiness 503
  **because no approved preview credentials are provisioned**.

## Strict opt-in mechanism

An approved DEV service may use a systemd credential file **only if**:
`APP_ENV=development` and
`BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED=true`.

The service's systemd unit/drop-in must explicitly declare a credential named
`gcp-secret-manager-bootstrap.json` via `LoadCredential=` or
`LoadCredentialEncrypted=`. systemd makes that file accessible below
`CREDENTIALS_DIRECTORY`; the existing library reads that exact filename.
It does not accept user-supplied path overrides, print the private key, or
copy the JSON into an environment variable.

Example template for review by an authorized VPS administrator **only**:
```ini
# DO NOT APPLY UNTIL APPROVED AND AN ADMIN-OWNED CREDENTIAL EXISTS.
# /etc/systemd/system/cst-bizportal-pr81-preview.service.d/30-gcp-bootstrap.conf
[Service]
Environment=BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED=true
LoadCredential=gcp-secret-manager-bootstrap.json:/etc/bizportal-pr81-preview/approved-gcp-bootstrap.json
```
The path on the right is a **placeholder for an operator-managed, root-
restricted credential source**, not a file created by these tests.
Review IAM so this credential has permission for the designated
CST-DEV secret only; never copy an existing live DEV or PROD bootstrap
credential to the preview without explicit authorization.

The old `GCP_SECRET_MANAGER_BOOTSTRAP_JSON` environment configuration remains
supported and takes precedence. Malformed explicit environment JSON is
rejected rather than falling back. In PROD, the systemd fallback is disabled
even if its opt-in flag is supplied. Files must be regular and 1–32768 bytes;
missing, invalid, and oversized credentials fail closed.

## Separate gates after authorization

1. Confirm the preview's base database resolves **CST-DEV** project
   `xssrfshdrtdfupgqwfdw` and never PROD project
   `nzdweipzckfszczzqtuw`. Only read-only readiness first.
2. Confirm SMTP readiness without sending a message.
3. Provision separate high-entropy OTP signing key and pin the exact active
   Super Admin account ID and email via the already implemented signed
   OTP flags. Only enable OTP in the preview after explicit approval;
   the account holder enters OTP directly in the HTTPS browser.
4. The Finance database credential uses a **different**, dedicated
   least-privileged PostgreSQL role and strict TLS/RLS. Do not share the
   base app/admin database identity with the Finance writer. Keep Finance,
   AP/Accounting writes, payment and background workers OFF pending
   independent authorization and E2E testing.
5. Validate an authenticated company-1 positive/company-3 negative read,
   draft-only AP/Accounting idempotency, and full rollback before any cutover.

## Safe verification

Run existing key-name-only diagnostic:
```sh
python3 /opt/cst-bizportal-pr81-preflight-20261115/preflight.py
```
It reports key presence and health categories, not credential contents.
The new opt-in can be tested using only a generated **synthetic** RSA key
and mocked OAuth/Secret Manager responses via
`dev-systemd-gcp-bootstrap.test.ts`.

No real bootstrap JSON, OTP, SMTP password, or database DSN should appear in
this PR, the example unit file, logs or GitHub Actions. This addition is
source-only; no systemd drop-in, secret file or service restart was performed.

## Restricted OTP login connection budget

The dedicated CST-DEV `bizportal_pr81_otp_login_dev` PostgreSQL role has
`CONNECTION LIMIT 1`. When this exact role (or its Supavisor
`role.project_ref` variant) is selected through the authorized DEV-only
application database URL, the common BizPortal database pool is now capped
at **1** regardless of the ordinary `DB_POOL_MAX` setting. This prevents
the default Node production pool (2 connections) exceeding the restricted
role's connection budget. All other roles and PROD preserve existing pool
limits. This is **not** a credential or login mechanism.

One concurrent DB connection is appropriate for the one-admin private OTP
preview but limits throughput; keep the preview isolated, avoid multiple
replicas of that role, and validate actual concurrency after approved
credential provisioning. Do not increase `rolconnlimit`, reuse a broad
database login, or weaken RLS to bypass connection errors.
