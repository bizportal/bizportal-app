# PR #81 DEV: reuse existing Super Admin password

This is a **source-only, opt-in** extension of the existing BizPortal email/password endpoint. No new user password, no second OTP step, no new identity provider, and no change to the production login. The existing role-aware login UI and database password hash are reused.

## Feature gate (isolated DEV candidate only)

The application runtime must explicitly use `APP_ENV=development` and an approved **CST-DEV-only, least-privileged application database connection**. That database login credential is a service secret; it must **never** equal the Super Admin's application password.

Configure these keys through an approved private runtime/Secret Manager delivery path. **Do not put their values in this repository or the issue/PR discussion.**

| Runtime variable | Required behavior |
| --- | --- |
| `BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV` | `true` only on the approved isolated preview |
| `BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV` | Exact approved active Super Admin email |
| `BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV` | Exact account ID in CST-DEV, not a new identity |
| `SESSION_SECRET` or `BIZPORTAL_SESSION_SECRET` | Independent high-entropy signing key, at least 32 characters |
| `BIZPORTAL_SIGNED_OTP_ENABLED_DEV` | Must **not** be `true` at the same time |
| `VITE_BIZPORTAL_DEV_PASSWORD_ONLY` (frontend build) | `true` to hide unused OTP tab and disallow empty-password DEV fallback |

Enabling password auth requires an approved DB principal that can **read only** the pinned Super Admin row (including existing hash), check active-email duplicates, validate company status, and read only the limited related data. The previous PR #81 role `bizportal_pr81_otp_login_dev` remains `NOLOGIN` until credential delivery is completed securely. Never reuse the shared `postgres`, Finance writer, AI Core or PROD credential.

## Server-side safeguards

- Authenticates only the explicitly pinned existing Super Admin ID/email and verifies the existing bcrypt hash.
- Denies inactive, status-revoked, role-demoted, duplicate-active-email and company-bound identities in DEV password mode.
- Uses existing signed HttpOnly + Secure session cookie and revalidates exact account ID/email/activity on subsequent requests.
- Disables legacy DEV no-password login and DEV email enumeration when signed authentication is requested, including misconfigured opt-ins.
- Keeps OTP and password feature flags mutually exclusive in DEV and defaults both OFF.
- Preserves production password/OTP behavior and the current Finance endpoint / RLS feature gates. Finance Writer and Accounting handoff remain OFF unless independently approved.
- Frontend role cache uses **server-verified** `user.role` rather than hardcoding `admin`.

## Deployment/verification sequence (not yet authorized)

1. Approve and securely provision a **DEV-only** application DB role/secret. Verify TLS CA, hostname, and role/RLS in a single read-only connection. Never disable certificate validation.
2. Run anonymous/forged-cookie, wrong-password, revoked-identity, and company-negative HTTP tests. Add independent rate limiting to the **password endpoint** in Nginx.
3. Build the frontend with `VITE_BIZPORTAL_DEV_PASSWORD_ONLY=true`, enable the password opt-in only on a separate HTTPS candidate, and test actual user-entered Super Admin password without revealing it to ChatGPT.
4. After signed password login and company-scoped Finance **read-only** E2E PASS, remove the temporary **extra Nginx Basic Auth login** from that candidate as an independently reviewed rollout. Do not remove it while the signed app login is still unverified.
5. Keep Finance Writer, payment/GL posting, Gmail/WA schedulers and PROD untouched. Do not merge this stacked review PR into main or cut over either existing DEV host without explicit release approval.

**No actual Super Admin password is needed in source tests**, and no OTP or financial transaction should be emitted during tests.
