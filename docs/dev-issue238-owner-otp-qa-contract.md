# CST-DEV Issue #238 — reuse signed Owner OTP for disposable PG17 QA (candidate)

This is a **DEV-only, disabled-by-default** Owner authorization endpoint. It reuses
BizPortal's existing verified signed OTP session and account lookup. It does not
issue or verify an OTP itself; no second user login or second signing secret is introduced.

## Current source contract
- `BIZPORTAL_ISSUE238_OWNER_OTP_DEV=true` AND `APP_ENV=development`
  AND existing signed OTP enabled: otherwise endpoints return 404.
- `BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV=https://dev-bizportal.cstlogistic.co.id`
  required for same-origin POST. It is not enabled automatically.
- `GET /api/auth/dev/issue238-qa/consent`: a real Owner-only web page with a test selector and explicit consent button. It obtains and signs a short-lived QA claim, but **does not send the proof to the VPS runner or execute PostgreSQL**. Always displays this limitation.
- `GET /api/auth/dev/issue238-qa/challenge?test=<allowlisted-test>`: signed
  session younger than 10 minutes, active Super Admin, CST scope; creates exact
  SHA-bounded claims, 60-second consent challenge.
- `POST /api/auth/dev/issue238-qa/approve`: explicit confirmation phrase
  `SETUJUI QA #238 DEV`, same-origin JSON request, HMAC challenge, same authenticated
  Owner, bounded expiry and exact 3-test whitelist. Returns only a JSON object
  `request: {claims, owner_signature}` containing Ed25519 signature over sorted
  canonical ASCII JSON. Does NOT execute commands or forward the proof.
- `GET /api/auth/dev/issue238-qa/public-key`: authenticated Super Admin only,
  exposes the PUBLIC PEM verifier for controlled enrollment, never a secret.
- Signing key is domain-separated via HKDF from the already-configured DEV
  signed-session secret, using Issue238-specific salt and info. Invoice attestation
  signatures cannot be reused.

## Required deployment and security gates — NOT DONE
1. Review/merge the source, run the whole BizPortal build, verify DEV signed-OTP
   Owner session works; enable feature flag only after official DEV deployment.
   **Do not enable it on PROD**.
2. Perform real authenticated Owner HTTP challenge/consent (no cookies or OTP
   stored in GitHub/chat). Verify QA public key fingerprint from that exact server.
3. Enroll its distinct public verification key into the existing local-only VPS
   `cst-issue238-issuer-dev` service via systemd credential; this service currently
   reports `CUSTODIAN_KEYS_NOT_PROVISIONED`.
4. Tie the proof's command_id/job_id to an **independently authenticated and
   durable OpenClaw work item**. The current challenge creates candidate IDs;
   it is not proof those IDs correspond to real authenticated work.
   Only the bound trusted broker may submit it to the issuer.
5. Issuer must verify and durably reject replay; only a genuine signed permit
   and isolated, audited VPS Docker runner can launch three exact-source
   network-none synthetic PG17 fixtures. The runner is not yet deployed.
6. Verify actual PG17 PASS/FAIL, rollback and no hosted database/PROD mutation
   before considering a separate hosted DBA installation or Invoice #108.

**Do not treat this endpoint's JSON or a successful unit test as a runtime QA approval.**
