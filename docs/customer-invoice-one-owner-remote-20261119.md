# One Owner/Super Admin OTP from separate device — DEV-only source

Child of signed BizPortal attestation Draft PR #152 and Customer Portal's
paired remote receipt candidate.

- `GET ...customer-invoice-attestation?remote=1&challenge=...` checks existing
  signed BizPortal Super Admin cookie but **never signs** on GET.
- The signer displays company, HMAC-linked document number and amount, and
  requires the Owner to press **Setujui satu kali**.
- Same-origin POST with the existing signed session validates the active
  Owner/tenant, Ed25519-signs the challenge and relays it only to the pinned
  Customer Portal origin over HTTPS. No service account/password/OTP token.
- The Portal re-verifies the signature and canonical accounting authorization
  at its original Invoice issuance boundary; no independent second Admin.
- Existing popup route remains available and feature flags default OFF.
- Synthetic isolated two-HTTP-server tests are not operational PROD/DEV E2E.
  No active deployment or DB/role changes.
