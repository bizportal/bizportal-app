# PR147 — CST-DEV Sheet reader secret handoff and activation (staged, not deployed)

**Environment:** CST-DEV Supabase project `xssrfshdrtdfupgqwfdw` and the VPS isolated candidate only. Never apply to PROD or the active BizPortal frontend/backend before the exact-head release gates.

## Existing infrastructure, no extra login or password creation

The PostgreSQL login roles `bizportal_finance_cst_login_dev` and `bizportal_finance_diva_login_dev` already exist and both have password metadata configured. Their company-bound, SELECT-only policies for `bank_sheet_configs` and `company_bank_accounts` have been applied on CST-DEV and privilege grants verified. The current active service instead connects with `bizportal_pr81_otp_login_dev`, which intentionally has no Sheet config SELECT.

Existing GCP Secret Manager helper `readSecret()` is reused. The previously created empty temporary containers may remain unused if the validated existing company bundle is used. Alternatively, create or bind **one** of these dedicated GCP secrets, each containing the raw PostgreSQL URL of the **existing** role, transmitted only through the authorized secret-management interface:

- CST: secret **`bizportal-pr147-bank-sheet-cst-dev`**, configured via **`PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV`**.
- Diva: secret **`bizportal-pr147-bank-sheet-diva-dev`**, configured via **`PR147_BANK_SHEET_DIVA_GCP_SECRET_NAME_DEV`**.

Set each key to its exact matching name. Each secret must contain the corresponding dedicated role's original authorized credential, **never the OTP/main pool user or `service_role`**. Each DB URL must target `aws-1-ap-southeast-2.pooler.supabase.com`, port 5432 or 6543, `/postgres`, with `sslmode=verify-full` and no other URL query parameters. The code constructs TLS options explicitly with certificate verification and hostname checking.

The existing GCP bootstrap credential `GCP_SECRET_MANAGER_BOOTSTRAP_JSON` must be available exclusively inside the dedicated DEV service process via protected deployment secrets and scoped only to reading these two secrets. If there is no authorized existing bootstrap for that service, **stop**: do not copy a bootstrap, credential, or access token from any other environment, browser, source repository or chat. Have the authorized GCP administrator configure the specific Secret Accessor permission.

Protected environment URLs `PR147_BANK_SHEET_CST_DATABASE_URL_DEV` and `PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV` are alternative deployment-only sources, **not** additional credentials. Never configure an environment URL and a Secret Manager name for the same company. The application refuses ambiguous/invalid/missing secret sources, unsupported tenants, wrong DB principals, wrong project/host, insecure TLS, credential hot-swaps, and production execution.

## Verified legacy source discovery (20 November 2026; no password rotation)

An authorized metadata-only inventory found an **existing** GCP project `secret-504012` with a Finance company credential bundle named `bizportal-marketplace-finance-dev-companies`, with enabled versions **1 and 2**. Its version 2 payload shape is JSON with `companies.1.role`, `companies.1.databaseUrl`, `companies.3.role`, `companies.3.databaseUrl`. The role identifiers in both versions match the **existing** `bizportal_finance_cst_login_dev` and `bizportal_finance_diva_login_dev` identities. The separate `bizportal-marketplace-finance-dev` version 3 identifies the **different** `bizportal_marketplace_finance_login_dev` role and MUST NOT be used for either PR147 reader.

**This is a role-name/source-discovery PASS only, NOT login/TLS credential validation.** Secret content must not be written to chat, logs, local plaintext files, GitHub, or shared service environment. A subsequent in-memory inspection of credential details was blocked by safety controls; no alternate technique should bypass that control. Do not copy the bundle to PR147 secrets or enable the reader merely because the role names match.

Temporary target project `cst-super-app` contains only **empty** secret containers `bizportal-pr147-bank-sheet-cst-dev` and `bizportal-pr147-bank-sheet-diva-dev` (zero versions) and a dedicated keyless service account `bizportal-pr147-reader-dev@cst-super-app.iam.gserviceaccount.com`, with Secret Accessor on only those two containers. The target project is provisional. The source project `secret-504012` also has a separate existing Finance reader identity; never reuse its key or issue project-wide secret access in order to bridge projects.

**No-rotation implementation now available in the candidate:** set only
`PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV=bizportal-marketplace-finance-dev-companies`
in the **isolated** DEV candidate, backed by the authorized GCP service identity for project `secret-504012`. The source payload must retain its existing `companies.1.role`, `companies.1.databaseUrl`, `companies.3.role`, and `companies.3.databaseUrl` structure. The reader selects the exact tenant entry and checks both the explicit role label and the URL username/DEV hostname/TLS. It does not copy either credential into temporary secret containers or reset a database password. This is a third, mutually exclusive source alternative: do not simultaneously set the CST/Diva direct-URL variables or dedicated per-company GCP secret-name variables. The existing `readSecret()` helper requires an **authorized, isolated GCP bootstrap** for the source project; a signed-in DELL CLI session is not a credential for the server. Do not extract or reuse an unrelated service account key. Missing bootstrap or unauthorized secret access must fail closed.

**Approved next action:** the authorized original credential custodian must attest, through the protected secret-management channel, that each original `databaseUrl` is current, authenticates with its exact company role to CST-DEV, verifies TLS and RLS, and remains in use or valid. Only then may a scoped runtime identity or approved protected delivery mechanism supply those original credentials to the isolated PR147 candidate; this must not rotate existing DB passwords, enable writes or switch live routing. Do not publish a new secret version until the identity and provenance checks pass.

## Required release proof (not yet completed)

1. CI exact-head: Release Gate, Reconciliation, QRIS, Orphan Guard and Finance Reader RLS Gate all SUCCESS. Confirm exact commit SHA and clean checkout; no rerun of already-passing tests needed.
2. In an **isolated DEV candidate** (no live Nginx/systemd switch), using approved secret delivery, perform real database connectivity with both dedicated login roles; confirm `CURRENT_USER=SESSION_USER`, `BYPASSRLS=false`, TLS certificate verification, `row_security_active`, CST sees two own configs (IDs 2 and 3) and Diva cannot read them. Confirm both roles have no Sheet config write privileges. No token or password in logs.
3. Verify signed Super Admin on the CST and Diva pages with authenticated GET; anonymous GET=401, wrong company=403, unscoped company=400, disabled Sheet edit/delete/sync=423 with zero OTP pool query. Finance and Payroll read-only E2E must show expected company isolation.
4. Compare historical fingerprints before and after: 21 Sheet-ID-4 mutations and seven journal links; preserve both missing and five non-final journals. No repair or reassignment without original source evidence and explicit custody plan.
5. Rehearse rollback of the candidate Nginx upstream and backend and confirm old website/API availability. Do not merge PR147 or switch Hostinger source until all above PASS and the user accepts read-only Sheet sync functionality for source-only DEV.

## Recovery

- If the reader fails, leave the original runtime and Nginx unchanged. The pool does not fall back to OTP/shared credentials.
- Dedicated RLS policy rollback is available at `artifacts/api-server/scripts/pr147-finance-sheet-scoped-reader-rollback-staged-only.sql`. **Use only with approval after collecting permission and fingerprint evidence**.
- No secret values, passwords, or database URL content may be committed, logged, emailed, or pasted into ChatGPT.
